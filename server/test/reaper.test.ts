import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../src/sessions/registry.js';
import { idleSessions, reapIdleSessions, startReaper } from '../src/sessions/reaper.js';
import type { TmuxDriver } from '../src/sessions/tmux.js';
import type { LaunchProfile, SessionInfo } from '../src/types.js';

class FakeTmuxDriver implements TmuxDriver {
  alive = new Set<string>();
  async newSession(name: string): Promise<void> {
    this.alive.add(name);
  }
  async hasSession(name: string): Promise<boolean> {
    return this.alive.has(name);
  }
  async killSession(name: string): Promise<void> {
    this.alive.delete(name);
  }
}

const tmuxProfile: LaunchProfile = {
  id: 'shell',
  label: 'Shell',
  kind: 'tmux',
  cwd: '/tmp',
  command: 'bash',
};

// `cat` idles forever holding stdin open, like a headless session waiting for
// a turn that never comes.
const headlessProfile: LaunchProfile = {
  id: 'echo',
  label: 'Echo agent',
  kind: 'headless',
  cwd: '/tmp',
  command: 'cat',
};

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-08T00:00:00.000Z');

function info(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'id',
    profileId: 'p',
    kind: 'headless',
    name: 'session',
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    status: 'running',
    ...over,
  };
}

describe('idleSessions', () => {
  it('selects headless sessions idle longer than the threshold', () => {
    const stale = info({ id: 'stale', lastActivityAt: new Date(NOW - 7 * HOUR).toISOString() });
    const fresh = info({ id: 'fresh', lastActivityAt: new Date(NOW - 5 * HOUR).toISOString() });
    expect(idleSessions([stale, fresh], NOW, 6 * HOUR).map((s) => s.id)).toEqual(['stale']);
  });

  it('never selects a tmux session, however idle', () => {
    const old = info({ kind: 'tmux', lastActivityAt: new Date(NOW - 100 * HOUR).toISOString() });
    expect(idleSessions([old], NOW, 6 * HOUR)).toEqual([]);
  });

  it('skips sessions that have already exited', () => {
    const dead = info({ status: 'exited', lastActivityAt: new Date(NOW - 7 * HOUR).toISOString() });
    expect(idleSessions([dead], NOW, 6 * HOUR)).toEqual([]);
  });

  it('falls back to createdAt when a session has no recorded activity', () => {
    const never = info({ id: 'never', lastActivityAt: undefined });
    expect(idleSessions([never], NOW, 6 * HOUR).map((s) => s.id)).toEqual(['never']);
  });

  it('leaves a session with an unparseable timestamp alone', () => {
    expect(idleSessions([info({ lastActivityAt: 'not-a-date' })], NOW, 6 * HOUR)).toEqual([]);
  });
});

describe('reapIdleSessions', () => {
  it('kills idle headless sessions and leaves active ones running', async () => {
    const reg = new SessionRegistry(new FakeTmuxDriver());
    const idle = await reg.spawn(headlessProfile);
    const tmux = await reg.spawn(tmuxProfile);
    try {
      // A zero threshold makes every session immediately "idle"; only the
      // headless one is eligible.
      const reaped = await reapIdleSessions(reg, -1);
      expect(reaped.map((s) => s.id)).toEqual([idle.id]);
      expect((await reg.list()).map((s) => s.id)).toEqual([tmux.id]);
    } finally {
      await reg.shutdown();
    }
  });

  it('reaps nothing when every session is within the idle window', async () => {
    const reg = new SessionRegistry(new FakeTmuxDriver());
    await reg.spawn(headlessProfile);
    try {
      expect(await reapIdleSessions(reg, 6 * HOUR)).toEqual([]);
      expect(await reg.list()).toHaveLength(1);
    } finally {
      await reg.shutdown();
    }
  });
});

describe('startReaper', () => {
  it('sweeps on its interval and reports what it reaped, until stopped', async () => {
    const reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn(headlessProfile);
    const reaped: SessionInfo[][] = [];
    const stop = startReaper(reg, { intervalMs: 5, maxIdleMs: -1, onReap: (r) => reaped.push(r) });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(reaped.flat().map((s) => s.id)).toEqual([session.id]);
      expect(await reg.list()).toHaveLength(0);
    } finally {
      stop();
      await reg.shutdown();
    }
    // After stopping, a fresh session survives further ticks.
    const reg2 = new SessionRegistry(new FakeTmuxDriver());
    await reg2.spawn(headlessProfile);
    await new Promise((r) => setTimeout(r, 30));
    expect(await reg2.list()).toHaveLength(1);
    await reg2.shutdown();
  });
});
