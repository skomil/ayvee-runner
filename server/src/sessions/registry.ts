import crypto from 'node:crypto';
import type { LaunchProfile, SessionEvent, SessionInfo } from '../types.js';
import { UsageTracker } from '../usage.js';
import { HeadlessProcess } from './headless.js';
import { RealTmuxDriver, type TmuxDriver } from './tmux.js';

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`no session with id ${id}`);
  }
}

export class SessionKindError extends Error {}

export interface SpawnOptions {
  /**
   * Launch `claude --remote-control <session name>` in the profile's cwd
   * instead of the profile command, registering the session with claude.ai.
   * The command is built here — never taken from the caller — so the
   * allowlist stays the boundary for what can run.
   */
  remoteControl?: boolean;
  /**
   * Claude model for the session (e.g. "sonnet", "claude-opus-5"), exported
   * as ANTHROPIC_MODEL in the session's environment. The allowlisted command
   * is never modified; non-Claude commands simply ignore the variable.
   */
  model?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface Record_ {
  info: SessionInfo;
  headless?: HeadlessProcess;
}

/**
 * In-memory registry of live sessions. Sessions do not survive a runner
 * restart by design — the processes they track wouldn't either (headless) or
 * are rediscoverable via tmux itself.
 */
export class SessionRegistry {
  private sessions = new Map<string, Record_>();

  constructor(
    private tmux: TmuxDriver = new RealTmuxDriver(),
    readonly usage: UsageTracker = new UsageTracker(),
  ) {}

  async spawn(profile: LaunchProfile, name?: string, opts?: SpawnOptions): Promise<SessionInfo> {
    if (opts?.remoteControl && profile.kind !== 'tmux') {
      throw new SessionKindError('remote control requires a tmux profile');
    }
    const id = crypto.randomUUID();
    const info: SessionInfo = {
      id,
      profileId: profile.id,
      kind: profile.kind,
      name: name ?? profile.label,
      createdAt: new Date().toISOString(),
      status: 'running',
    };
    if (opts?.model) info.model = opts.model;
    const env = opts?.model ? { ANTHROPIC_MODEL: opts.model } : undefined;
    if (profile.kind === 'tmux') {
      info.tmuxName = `ayr-${id.slice(0, 8)}`;
      const command = opts?.remoteControl
        ? `claude --remote-control ${shellQuote(info.name)}`
        : profile.command;
      if (opts?.remoteControl) info.remoteControl = true;
      await this.tmux.newSession(info.tmuxName, profile.cwd, command, env);
      this.sessions.set(id, { info });
    } else {
      const proc = new HeadlessProcess(
        profile.command,
        profile.cwd,
        (counts) => this.usage.record(counts),
        env,
      );
      this.sessions.set(id, { info, headless: proc });
    }
    return this.get(id);
  }

  async list(): Promise<SessionInfo[]> {
    return Promise.all([...this.sessions.keys()].map((id) => this.get(id)));
  }

  /** Fetch a session, refreshing its liveness from the underlying mechanism. */
  async get(id: string): Promise<SessionInfo> {
    const rec = this.sessions.get(id);
    if (!rec) throw new SessionNotFound(id);
    if (rec.info.kind === 'tmux') {
      if (rec.info.status === 'running' && !(await this.tmux.hasSession(rec.info.tmuxName!))) {
        rec.info.status = 'exited';
      }
    } else {
      const proc = rec.headless!;
      if (proc.exited) {
        rec.info.status = 'exited';
        rec.info.exitCode = proc.exitCode;
      }
    }
    return { ...rec.info };
  }

  async kill(id: string): Promise<SessionInfo> {
    const rec = this.sessions.get(id);
    if (!rec) throw new SessionNotFound(id);
    if (rec.info.kind === 'tmux') {
      await this.tmux.killSession(rec.info.tmuxName!);
      rec.info.status = 'exited';
    } else {
      rec.headless!.kill();
    }
    this.sessions.delete(id);
    return { ...rec.info, status: 'exited' };
  }

  /** Dispatch a user turn to a headless session. */
  sendInput(id: string, text: string): void {
    const rec = this.sessions.get(id);
    if (!rec) throw new SessionNotFound(id);
    if (!rec.headless) {
      throw new SessionKindError('input can only be sent to headless sessions');
    }
    rec.headless.sendMessage(text);
  }

  eventsSince(id: string, since: number): SessionEvent[] {
    const rec = this.sessions.get(id);
    if (!rec) throw new SessionNotFound(id);
    if (!rec.headless) {
      throw new SessionKindError('only headless sessions produce events');
    }
    return rec.headless.eventsSince(since);
  }

  /** Kill every live session (used on server shutdown and in tests). */
  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.kill(id).catch(() => undefined);
    }
  }
}
