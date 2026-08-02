export type SessionKind = 'tmux' | 'headless';

/** One entry in the runner's local allowlist. Ayvee only ever sends a profile id. */
export interface LaunchProfile {
  id: string;
  label: string;
  kind: SessionKind;
  cwd: string;
  command: string;
  /** True for profiles the runner ships; user profiles come from disk. */
  builtin?: boolean;
}

export type SessionStatus = 'running' | 'exited';

export interface SessionInfo {
  id: string;
  profileId: string;
  kind: SessionKind;
  name: string;
  createdAt: string;
  status: SessionStatus;
  /** tmux sessions only: the tmux session name for `tmux attach`. */
  tmuxName?: string;
  /** tmux sessions only: true when running `claude --remote-control`. */
  remoteControl?: boolean;
  /** Claude model requested at spawn (exported as ANTHROPIC_MODEL). */
  model?: string;
  /** headless sessions only: exit code once the process has exited. */
  exitCode?: number | null;
}

/** One line of stream-json output from a headless session. */
export interface SessionEvent {
  seq: number;
  ts: string;
  /** Parsed JSON if the line was valid JSON, else `{ raw: string }`. */
  data: unknown;
}
