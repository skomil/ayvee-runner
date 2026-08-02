/** Aggregation of Claude token usage reported by headless sessions. */

export interface TokenCounts {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
  /** Cache write (cache_creation_input_tokens). */
  cacheCreation: number;
  /** Cache read (cache_read_input_tokens). */
  cacheRead: number;
}

export interface UsageSnapshot {
  windowHours: number;
  window: TokenCounts & { total: number };
  lifetime: TokenCounts & { total: number };
  limit: {
    /** Configured 5-hour token limit, or null when not configured. */
    tokens: number | null;
    /** Percent of the limit used within the window, or null without a limit. */
    usedPercent: number | null;
    /** Tokens still available in this window (never negative), or null. */
    remainingTokens: number | null;
    /** Percent of the limit still available (0–100), or null. */
    remainingPercent: number | null;
  };
}

const WINDOW_HOURS = 5;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function total(c: TokenCounts): number {
  return c.input + c.output + c.cacheCreation + c.cacheRead;
}

/**
 * Extract token counts from one stream-json event, or null if it carries no
 * usage. Only `assistant` events count — `result` events repeat the turn's
 * cumulative usage and would double-count it.
 */
export function usageFromEvent(data: unknown): TokenCounts | null {
  const event = data as { type?: unknown; message?: { usage?: Record<string, unknown> } };
  if (event?.type !== 'assistant') return null;
  const usage = event.message?.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheCreation: num(usage.cache_creation_input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
  };
}

/**
 * Tracks token usage in a rolling 5-hour window (mirroring Claude's session
 * limit window) plus lifetime totals since the runner started.
 */
export class UsageTracker {
  private samples: Array<{ ts: number; counts: TokenCounts }> = [];
  private lifetime = emptyCounts();

  record(counts: TokenCounts, ts: number = Date.now()): void {
    this.samples.push({ ts, counts });
    this.lifetime.input += counts.input;
    this.lifetime.output += counts.output;
    this.lifetime.cacheCreation += counts.cacheCreation;
    this.lifetime.cacheRead += counts.cacheRead;
  }

  /**
   * Usage in the trailing window. `limitTokens` is passed in per call (read
   * from config on each request) so a limit change applies without a restart.
   */
  snapshot(now: number = Date.now(), limitTokens: number | null = null): UsageSnapshot {
    this.samples = this.samples.filter((s) => s.ts > now - WINDOW_MS);
    const window = emptyCounts();
    for (const { counts } of this.samples) {
      window.input += counts.input;
      window.output += counts.output;
      window.cacheCreation += counts.cacheCreation;
      window.cacheRead += counts.cacheRead;
    }
    const windowTotal = total(window);
    const hasLimit = limitTokens !== null && limitTokens > 0;
    const usedPercent = hasLimit ? Math.round((windowTotal / limitTokens) * 10000) / 100 : null;
    return {
      windowHours: WINDOW_HOURS,
      window: { ...window, total: windowTotal },
      lifetime: { ...this.lifetime, total: total(this.lifetime) },
      limit: {
        tokens: hasLimit ? limitTokens : null,
        usedPercent,
        remainingTokens: hasLimit ? Math.max(0, limitTokens - windowTotal) : null,
        remainingPercent: usedPercent === null ? null : Math.max(0, Math.round((100 - usedPercent) * 100) / 100),
      },
    };
  }
}
