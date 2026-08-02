import { describe, expect, it } from 'vitest';
import { ClaudeUsageProvider, parseUsagePeriods, parseUsageReport } from '../src/claudeUsage.js';

// Verbatim output of `claude -p "/usage"`, captured from the real CLI.
const REPORT = `You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Aug 2, 4:09am (UTC)
Current week (all models): 13% used · resets Aug 7, 7:59pm (UTC)
Current week (Fable): 16% used · resets Aug 7, 8pm (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 309 requests · 24 sessions
  75% of your usage was at >150k context
  Top skills: /update-config 1%, /herbert:kanban 1%
  Top plugins: herbert 1%
  Top MCP servers: plugin:herbert:herbert 61%, claude.ai ayvee 1%

Last 7d · 419 requests · 28 sessions
  68% of your usage was at >150k context
  17% of your usage came from subagent-heavy sessions
  Top skills: /update-config 1%, /herbert:kanban 1%
  Top subagents: Explore 3%, Plan 2%
  Top plugins: herbert 1%
  Top MCP servers: plugin:herbert:herbert 57%, persona 3%`;

describe('parseUsageReport', () => {
  it('reads every limit window with used, left, and reset time', () => {
    expect(parseUsageReport(REPORT)).toEqual([
      {
        label: 'session',
        scope: 'session',
        model: null,
        usedPercent: 20,
        remainingPercent: 80,
        resetsAt: 'Aug 2, 4:09am (UTC)',
      },
      {
        label: 'week (all models)',
        scope: 'week',
        model: null,
        usedPercent: 13,
        remainingPercent: 87,
        resetsAt: 'Aug 7, 7:59pm (UTC)',
      },
      {
        label: 'week (Fable)',
        scope: 'week',
        model: 'Fable',
        usedPercent: 16,
        remainingPercent: 84,
        resetsAt: 'Aug 7, 8pm (UTC)',
      },
    ]);
  });

  it('handles fractional percentages and a fully used window', () => {
    const limits = parseUsageReport('Current session: 99.5% used · resets soon\n');
    expect(limits[0]).toMatchObject({ usedPercent: 99.5, remainingPercent: 0.5 });
    expect(parseUsageReport('Current session: 100% used · resets soon')[0]!.remainingPercent).toBe(
      0,
    );
  });

  it('returns nothing for unrelated or empty output', () => {
    expect(parseUsageReport('')).toEqual([]);
    expect(parseUsageReport('Not logged in.')).toEqual([]);
  });
});

describe('parseUsagePeriods', () => {
  it('reads request and session counts for each period', () => {
    const periods = parseUsagePeriods(REPORT);
    expect(periods.map((p) => [p.label, p.requests, p.sessions])).toEqual([
      ['Last 24h', 309, 24],
      ['Last 7d', 419, 28],
    ]);
  });

  it('reads behaviour percentages, stripping the "of your usage" filler', () => {
    const [day, week] = parseUsagePeriods(REPORT);
    expect(day!.behaviors).toEqual([{ percent: 75, description: 'was at >150k context' }]);
    expect(week!.behaviors).toEqual([
      { percent: 68, description: 'was at >150k context' },
      { percent: 17, description: 'came from subagent-heavy sessions' },
    ]);
  });

  it('reads every Top-N breakdown, including names containing spaces or colons', () => {
    const [day, week] = parseUsagePeriods(REPORT);
    expect(day!.breakdowns).toEqual([
      {
        category: 'skills',
        entries: [
          { name: '/update-config', percent: 1 },
          { name: '/herbert:kanban', percent: 1 },
        ],
      },
      { category: 'plugins', entries: [{ name: 'herbert', percent: 1 }] },
      {
        category: 'MCP servers',
        entries: [
          { name: 'plugin:herbert:herbert', percent: 61 },
          { name: 'claude.ai ayvee', percent: 1 },
        ],
      },
    ]);
    expect(week!.breakdowns.map((b) => b.category)).toEqual([
      'skills',
      'subagents',
      'plugins',
      'MCP servers',
    ]);
  });

  it('returns nothing when there is no contributing-usage section', () => {
    expect(parseUsagePeriods('Current session: 20% used · resets soon')).toEqual([]);
  });
});

describe('ClaudeUsageProvider', () => {
  it('reports parsed limits with provenance', async () => {
    const provider = new ClaudeUsageProvider(60_000, async () => REPORT);
    const report = await provider.get(1_000);
    expect(report?.source).toBe('claude-cli');
    expect(report?.note).toMatch(/does not include other devices/);
    expect(report?.limits).toHaveLength(3);
  });

  it('carries the summary line, the periods, and the raw report', async () => {
    const provider = new ClaudeUsageProvider(60_000, async () => REPORT);
    const report = await provider.get(1_000);
    expect(report?.summary).toBe(
      'You are currently using your subscription to power your Claude Code usage',
    );
    expect(report?.periods.map((p) => p.label)).toEqual(['Last 24h', 'Last 7d']);
    expect(report?.raw).toBe(REPORT);
  });

  it('falls back to a default note when the CLI prints none', async () => {
    const provider = new ClaudeUsageProvider(60_000, async () => 'Current session: 5% used · resets soon');
    const report = await provider.get();
    expect(report?.note).toMatch(/Reported by the Claude CLI/);
    expect(report?.summary).toBeNull();
    expect(report?.periods).toEqual([]);
  });

  it('caches within the TTL and refreshes after it', async () => {
    let calls = 0;
    let percent = 20;
    const provider = new ClaudeUsageProvider(1000, async () => {
      calls++;
      return `Current session: ${percent}% used · resets later`;
    });
    expect((await provider.get(0))?.limits[0]!.usedPercent).toBe(20);
    percent = 55;
    expect((await provider.get(500))?.limits[0]!.usedPercent).toBe(20); // cached
    expect(calls).toBe(1);
    expect((await provider.get(2000))?.limits[0]!.usedPercent).toBe(55);
    expect(calls).toBe(2);
  });

  it('coalesces concurrent refreshes into one CLI call', async () => {
    let calls = 0;
    const provider = new ClaudeUsageProvider(60_000, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return REPORT;
    });
    const [a, b] = await Promise.all([provider.get(0), provider.get(0)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('returns null when the CLI is unavailable', async () => {
    const provider = new ClaudeUsageProvider(60_000, async () => {
      throw new Error('claude: command not found');
    });
    expect(await provider.get()).toBeNull();
  });

  it('keeps the last good reading when a later call fails', async () => {
    let fail = false;
    const provider = new ClaudeUsageProvider(0, async () => {
      if (fail) throw new Error('transient');
      return REPORT;
    });
    const good = await provider.get(0);
    fail = true;
    expect(await provider.get(10_000)).toEqual(good);
  });
});
