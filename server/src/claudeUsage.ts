import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One limit window as the Claude CLI reports it in `/usage`. */
export interface ClaudeLimit {
  /** Display label, e.g. "session" or "week (all models)". */
  label: string;
  scope: 'session' | 'week';
  /** Model the weekly limit applies to, when the CLI scopes it to one. */
  model: string | null;
  usedPercent: number;
  remainingPercent: number;
  /** Reset time exactly as the CLI prints it, e.g. "Aug 2, 4:09am (UTC)". */
  resetsAt: string;
}

/** One "Top <category>" entry, e.g. `{ name: 'Explore', percent: 3 }`. */
export interface UsageEntry {
  name: string;
  percent: number;
}

/** A "Top skills / subagents / plugins / MCP servers" list. */
export interface UsageBreakdown {
  category: string;
  entries: UsageEntry[];
}

/** A percentage characteristic, e.g. 75% of usage at >150k context. */
export interface UsageBehavior {
  percent: number;
  description: string;
}

/** One "what's contributing to your limits usage" window (24h, 7d). */
export interface UsagePeriod {
  label: string;
  requests: number | null;
  sessions: number | null;
  behaviors: UsageBehavior[];
  breakdowns: UsageBreakdown[];
}

export interface ClaudeUsageReport {
  source: 'claude-cli';
  fetchedAt: string;
  /** The CLI's opening line, e.g. which plan is powering usage. */
  summary: string | null;
  note: string;
  limits: ClaudeLimit[];
  periods: UsagePeriod[];
  /** The full report text, so nothing the CLI prints is lost. */
  raw: string;
}

const NOTE =
  'Reported by the Claude CLI (/usage): approximate, based on local sessions on this machine — does not include other devices or claude.ai.';

// e.g. "Current session: 20% used · resets Aug 2, 4:09am (UTC)"
//      "Current week (all models): 13% used · resets Aug 7, 7:59pm (UTC)"
const LINE = /^Current (session|week)(?:\s*\(([^)]*)\))?:\s*(\d+(?:\.\d+)?)%\s*used\s*\W+\s*resets\s+(.+?)\s*$/gm;

// e.g. "Last 24h · 309 requests · 24 sessions"
const PERIOD = /^(Last\s+[^\s·]+)\s*·\s*(.+)$/;
// e.g. "  Top MCP servers: plugin:herbert:herbert 61%, claude.ai ayvee 1%"
const TOP = /^\s+Top\s+([^:]+):\s*(.+)$/;
// e.g. "  75% of your usage was at >150k context"
const BEHAVIOR = /^\s+(\d+(?:\.\d+)?)%\s+(.+?)\s*$/;
// e.g. "plugin:herbert:herbert 61%" — names may contain spaces.
const ENTRY = /^(.*?)\s+(\d+(?:\.\d+)?)%$/;

function parseEntries(list: string): UsageEntry[] {
  return list
    .split(',')
    .map((part) => ENTRY.exec(part.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!.trim(), percent: Number(match[2]) }));
}

function countIn(text: string, unit: string): number | null {
  const match = new RegExp(`(\\d+)\\s+${unit}`).exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Extract the "what's contributing to your limits usage" periods — request
 * and session counts, behaviour percentages, and the Top-N breakdowns.
 */
export function parseUsagePeriods(text: string): UsagePeriod[] {
  const periods: UsagePeriod[] = [];
  for (const line of text.split('\n')) {
    const period = PERIOD.exec(line);
    if (period) {
      periods.push({
        label: period[1]!.trim(),
        requests: countIn(period[2]!, 'requests?'),
        sessions: countIn(period[2]!, 'sessions?'),
        behaviors: [],
        breakdowns: [],
      });
      continue;
    }
    const current = periods[periods.length - 1];
    if (!current) continue;
    const top = TOP.exec(line);
    if (top) {
      current.breakdowns.push({
        category: top[1]!.trim(),
        entries: parseEntries(top[2]!),
      });
      continue;
    }
    const behavior = BEHAVIOR.exec(line);
    if (behavior) {
      current.behaviors.push({
        percent: Number(behavior[1]),
        description: behavior[2]!.replace(/^of your usage\s+/, ''),
      });
    }
  }
  return periods;
}

/** Extract the limit lines from the CLI's `/usage` output. */
export function parseUsageReport(text: string): ClaudeLimit[] {
  const limits: ClaudeLimit[] = [];
  for (const match of text.matchAll(LINE)) {
    const [, scope, qualifier, percent, resetsAt] = match;
    const usedPercent = Number(percent);
    if (!Number.isFinite(usedPercent)) continue;
    limits.push({
      label: qualifier ? `${scope} (${qualifier})` : scope!,
      scope: scope === 'week' ? 'week' : 'session',
      model: scope === 'week' && qualifier && qualifier !== 'all models' ? qualifier : null,
      usedPercent,
      remainingPercent: Math.max(0, Math.round((100 - usedPercent) * 100) / 100),
      resetsAt: resetsAt!,
    });
  }
  return limits;
}

/** Run `claude -p "/usage"` and return its report text. */
async function runClaudeUsage(): Promise<string> {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', '/usage', '--output-format', 'json'],
    // A local slash command: no model call, so this is fast and costs nothing.
    { cwd: os.tmpdir(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { result?: unknown };
  return typeof parsed.result === 'string' ? parsed.result : '';
}

/**
 * Reads real limit usage from the Claude CLI, cached briefly so a polling
 * dashboard doesn't spawn a process per refresh. Unavailable CLI (not
 * installed, not logged in, output changed) yields null rather than an error:
 * usage reporting must never take the runner down.
 */
export class ClaudeUsageProvider {
  private cached: ClaudeUsageReport | null = null;
  private cachedAt = 0;
  private inFlight: Promise<ClaudeUsageReport | null> | null = null;

  constructor(
    private ttlMs = 60_000,
    private run: () => Promise<string> = runClaudeUsage,
  ) {}

  async get(now: number = Date.now()): Promise<ClaudeUsageReport | null> {
    if (this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    this.inFlight ??= this.refresh(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(now: number): Promise<ClaudeUsageReport | null> {
    try {
      const raw = await this.run();
      const limits = parseUsageReport(raw);
      if (limits.length === 0) return this.cached;
      const lines = raw.split('\n').map((line) => line.trim());
      this.cached = {
        source: 'claude-cli',
        fetchedAt: new Date(now).toISOString(),
        summary: lines.find((line) => line.startsWith('You are currently using')) ?? null,
        // Prefer the CLI's own caveat so the wording tracks the CLI.
        note: lines.find((line) => line.startsWith('Approximate,')) ?? NOTE,
        limits,
        periods: parseUsagePeriods(raw),
        raw,
      };
      this.cachedAt = now;
      return this.cached;
    } catch {
      return this.cached; // keep the last good reading if there was one
    }
  }
}
