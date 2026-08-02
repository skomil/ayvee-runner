import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the tmux CLI, injectable so unit tests can fake it.
 * The command runs inside tmux exactly as written in the launch profile.
 */
export interface TmuxDriver {
  newSession(name: string, cwd: string, command: string, env?: Record<string, string>): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
}

export class RealTmuxDriver implements TmuxDriver {
  async newSession(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    await execFileAsync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs, command]);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      // `=` prefix demands an exact match instead of tmux's prefix matching.
      await execFileAsync('tmux', ['has-session', '-t', `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await execFileAsync('tmux', ['kill-session', '-t', `=${name}`]);
    } catch {
      // Already gone (e.g. the user exited the shell) — killing is idempotent.
    }
  }
}
