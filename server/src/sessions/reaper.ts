import type { SessionInfo } from '../types.js';
import type { SessionRegistry } from './registry.js';

/** How often the maintenance sweep runs. */
export const REAP_INTERVAL_MS = 30 * 60_000;
/** How long a headless session may sit idle before it is reaped. */
export const MAX_IDLE_MS = 6 * 60 * 60_000;

export interface ReaperOptions {
  intervalMs?: number;
  maxIdleMs?: number;
  onReap?: (reaped: SessionInfo[]) => void;
}

/**
 * Headless sessions idle longer than `maxIdleMs`. Only headless sessions are
 * candidates: a tmux session is interactive and may have a human attached to
 * it, so quiet is not the same as abandoned. An unparseable timestamp yields
 * NaN and therefore no reap — the sweep never guesses.
 */
export function idleSessions(
  sessions: SessionInfo[],
  now: number,
  maxIdleMs: number,
): SessionInfo[] {
  return sessions.filter(
    (s) =>
      s.kind === 'headless' &&
      s.status === 'running' &&
      now - Date.parse(s.lastActivityAt ?? s.createdAt) > maxIdleMs,
  );
}

/** Run one sweep, returning the sessions that were killed. */
export async function reapIdleSessions(
  registry: SessionRegistry,
  maxIdleMs: number = MAX_IDLE_MS,
): Promise<SessionInfo[]> {
  const stale = idleSessions(await registry.list(), Date.now(), maxIdleMs);
  const reaped: SessionInfo[] = [];
  for (const session of stale) {
    // A session that exited or was killed between the list and the kill is
    // already gone; that is the outcome we wanted either way.
    try {
      await registry.kill(session.id);
      reaped.push(session);
    } catch {
      continue;
    }
  }
  return reaped;
}

/**
 * Start the periodic maintenance sweep. Returns a stop function; the timer is
 * unref'd so it never holds the process open on its own.
 */
export function startReaper(registry: SessionRegistry, opts: ReaperOptions = {}): () => void {
  const maxIdleMs = opts.maxIdleMs ?? MAX_IDLE_MS;
  const timer = setInterval(() => {
    void reapIdleSessions(registry, maxIdleMs).then((reaped) => {
      if (reaped.length > 0) opts.onReap?.(reaped);
    });
  }, opts.intervalMs ?? REAP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
