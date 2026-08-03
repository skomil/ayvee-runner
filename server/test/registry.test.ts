import { afterEach, describe, expect, it } from 'vitest';
import { SessionKindError, SessionNotFound, SessionRegistry } from '../src/sessions/registry.js';
import type { TmuxDriver } from '../src/sessions/tmux.js';
import type { LaunchProfile, SessionEvent } from '../src/types.js';

class FakeTmuxDriver implements TmuxDriver {
  alive = new Set<string>();
  calls: string[][] = [];
  envs: Array<Record<string, string> | undefined> = [];

  async newSession(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    this.calls.push(['new-session', name, cwd, command]);
    this.envs.push(env);
    this.alive.add(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.alive.has(name);
  }

  async killSession(name: string): Promise<void> {
    this.calls.push(['kill-session', name]);
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

// `cat` echoes each stream-json input line straight back, standing in for a
// persistent headless Claude process.
const headlessProfile: LaunchProfile = {
  id: 'echo',
  label: 'Echo agent',
  kind: 'headless',
  cwd: '/tmp',
  command: 'cat',
};

async function eventually<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('SessionRegistry with tmux sessions', () => {
  it('spawns via the driver and lists the session as running', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    const session = await reg.spawn(tmuxProfile, 'my shell');
    expect(session.kind).toBe('tmux');
    expect(session.name).toBe('my shell');
    expect(session.status).toBe('running');
    expect(session.tmuxName).toMatch(/^ayr-/);
    expect(tmux.calls[0]).toEqual(['new-session', session.tmuxName, '/tmp', 'bash']);
    expect(await reg.list()).toHaveLength(1);
  });

  it('defaults the session name to the profile label', async () => {
    const reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn(tmuxProfile);
    expect(session.name).toBe('Shell');
  });

  it('reports exited when the tmux session disappears externally', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    const session = await reg.spawn(tmuxProfile);
    tmux.alive.clear();
    expect((await reg.get(session.id)).status).toBe('exited');
  });

  it('kill removes the session and calls kill-session', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    const session = await reg.spawn(tmuxProfile);
    const killed = await reg.kill(session.id);
    expect(killed.status).toBe('exited');
    expect(tmux.calls.some((c) => c[0] === 'kill-session')).toBe(true);
    await expect(reg.get(session.id)).rejects.toThrow(SessionNotFound);
    expect(await reg.list()).toHaveLength(0);
  });

  it('remote control launches the runner-built claude command, not the profile command', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    const session = await reg.spawn(tmuxProfile, 'my rc session', { remoteControl: true });
    expect(session.remoteControl).toBe(true);
    expect(tmux.calls[0]).toEqual([
      'new-session',
      session.tmuxName,
      '/tmp',
      "claude --remote-control 'my rc session' --permission-mode auto",
    ]);
  });

  it('shell-quotes a hostile session name in the remote-control command', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    await reg.spawn(tmuxProfile, `x'; touch /tmp/pwned; echo '`, { remoteControl: true });
    expect(tmux.calls[0]![3]).toBe(
      `claude --remote-control 'x'\\''; touch /tmp/pwned; echo '\\''' --permission-mode auto`,
    );
  });

  it('passes the requested model to tmux as ANTHROPIC_MODEL', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    const session = await reg.spawn(tmuxProfile, undefined, { model: 'claude-opus-5' });
    expect(session.model).toBe('claude-opus-5');
    expect(tmux.envs[0]).toEqual({ ANTHROPIC_MODEL: 'claude-opus-5' });
  });

  it('passes no env when no model is requested', async () => {
    const tmux = new FakeTmuxDriver();
    const reg = new SessionRegistry(tmux);
    const session = await reg.spawn(tmuxProfile);
    expect(session.model).toBeUndefined();
    expect(tmux.envs[0]).toBeUndefined();
  });

  it('rejects remote control for headless profiles', async () => {
    const reg = new SessionRegistry(new FakeTmuxDriver());
    await expect(reg.spawn(headlessProfile, undefined, { remoteControl: true })).rejects.toThrow(
      SessionKindError,
    );
  });

  it('rejects input and events for tmux sessions', async () => {
    const reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn(tmuxProfile);
    expect(() => reg.sendInput(session.id, 'hi')).toThrow(SessionKindError);
    expect(() => reg.eventsSince(session.id, 0)).toThrow(SessionKindError);
  });
});

describe('SessionRegistry with headless sessions', () => {
  let reg: SessionRegistry;

  afterEach(async () => {
    await reg.shutdown();
  });

  it('spawns, echoes dispatched input back as parsed events, and kills', async () => {
    reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn(headlessProfile);
    expect(session.status).toBe('running');

    reg.sendInput(session.id, 'hello runner');
    const events = await eventually(
      () => reg.eventsSince(session.id, 0),
      (evs: SessionEvent[]) => evs.length > 0,
    );
    expect(events[0]!.data).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello runner' }] },
    });

    // `since` pagination: nothing new after the last seq.
    expect(reg.eventsSince(session.id, events[events.length - 1]!.seq)).toEqual([]);

    await reg.kill(session.id);
    await expect(reg.get(session.id)).rejects.toThrow(SessionNotFound);
  });

  it('marks the session exited with its exit code when the process dies', async () => {
    reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn({ ...headlessProfile, command: 'exit 3' });
    const info = await eventually(
      () => reg.get(session.id),
      (s) => s.status === 'exited',
    );
    expect(info.exitCode).toBe(3);
  });

  it('rejects input to an exited session', async () => {
    reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn({ ...headlessProfile, command: 'true' });
    await eventually(
      () => reg.get(session.id),
      (s) => s.status === 'exited',
    );
    expect(() => reg.sendInput(session.id, 'hi')).toThrow(/exited/);
  });

  it('does not deadlock when the process floods stderr past the pipe buffer', async () => {
    reg = new SessionRegistry(new FakeTmuxDriver());
    // 200KB of stderr well exceeds the ~64KB pipe buffer; without draining,
    // the child would block before ever printing to stdout.
    const session = await reg.spawn({
      ...headlessProfile,
      command: "head -c 200000 /dev/zero | tr '\\0' x >&2; echo done",
    });
    const events = await eventually(
      () => reg.eventsSince(session.id, 0),
      (evs: SessionEvent[]) => evs.length > 0,
      5000,
    );
    expect(events[0]!.data).toEqual({ raw: 'done' });
  });

  it('exports ANTHROPIC_MODEL into a headless session environment', async () => {
    reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn(
      { ...headlessProfile, command: 'echo "model=$ANTHROPIC_MODEL"' },
      undefined,
      { model: 'sonnet' },
    );
    const events = await eventually(
      () => reg.eventsSince(session.id, 0),
      (evs: SessionEvent[]) => evs.length > 0,
    );
    expect(events[0]!.data).toEqual({ raw: 'model=sonnet' });
  });

  it('keeps non-JSON output lines as raw events', async () => {
    reg = new SessionRegistry(new FakeTmuxDriver());
    const session = await reg.spawn({ ...headlessProfile, command: 'echo not-json' });
    const events = await eventually(
      () => reg.eventsSince(session.id, 0),
      (evs: SessionEvent[]) => evs.length > 0,
    );
    expect(events[0]!.data).toEqual({ raw: 'not-json' });
  });
});
