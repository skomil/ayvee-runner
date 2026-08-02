import { spawn, type ChildProcess } from 'node:child_process';
import type { SessionEvent } from '../types.js';
import { usageFromEvent, type TokenCounts } from '../usage.js';

const MAX_EVENTS = 1000;

/**
 * A persistent headless process (in production: `claude -p
 * --input-format=stream-json`). Stdin stays open so turns can be dispatched
 * for the session's lifetime; stdout is collected line-by-line as events.
 */
export class HeadlessProcess {
  readonly child: ChildProcess;
  exitCode: number | null = null;
  exited = false;
  private events: SessionEvent[] = [];
  private nextSeq = 1;
  private stdoutBuf = '';
  private stderrChunks: string[] = [];

  constructor(
    command: string,
    cwd: string,
    private onUsage?: (counts: TokenCounts) => void,
    env?: Record<string, string>,
  ) {
    this.child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : undefined,
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    // Drain stderr — an unread pipe fills at ~64KB and would block a chatty
    // child (e.g. `claude --verbose`). Keep a short tail for diagnostics.
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk);
      while (this.stderrChunks.length > 50) this.stderrChunks.shift();
    });
    this.child.on('exit', (code) => {
      if (this.stdoutBuf !== '') {
        this.pushLine(this.stdoutBuf);
        this.stdoutBuf = '';
      }
      this.exited = true;
      this.exitCode = code;
    });
    // Without a handler, a spawn failure (e.g. missing binary) would crash
    // the server process; 'exit' still fires and marks the session exited.
    this.child.on('error', () => undefined);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
      this.pushLine(this.stdoutBuf.slice(0, idx));
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
    }
  }

  private pushLine(line: string): void {
    if (line.trim() === '') return;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      data = { raw: line };
    }
    this.events.push({ seq: this.nextSeq++, ts: new Date().toISOString(), data });
    const usage = usageFromEvent(data);
    if (usage && this.onUsage) this.onUsage(usage);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  /** Dispatch one user turn in Claude Code's stream-json input format. */
  sendMessage(text: string): void {
    if (this.exited || !this.child.stdin?.writable) {
      throw new Error('session process has exited');
    }
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    this.child.stdin.write(`${line}\n`);
  }

  /** Recent stderr output, for diagnosing a failed or crashing launch. */
  get stderrTail(): string {
    return this.stderrChunks.join('');
  }

  /** Events with seq greater than `since` (0 = all retained events). */
  eventsSince(since: number): SessionEvent[] {
    return this.events.filter((e) => e.seq > since);
  }

  kill(): void {
    if (!this.exited) {
      this.child.kill('SIGTERM');
    }
  }
}
