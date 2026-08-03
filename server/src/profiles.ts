import fs from 'node:fs';
import path from 'node:path';
import { loadProfiles, profilesPath, runnerHome } from './config.js';
import type { LaunchProfile, SessionKind } from './types.js';

/** Scratch directory conversation sessions run in — no repo, no project files. */
export function workspaceDir(home: string = runnerHome()): string {
  return path.join(home, 'workspace');
}

// A conversation must never inherit this machine's MCP servers: an empty
// config plus --strict-mcp-config forces the built-in toolset only.
const ISOLATE_MCP = `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`;
const STREAM_JSON = '-p --input-format=stream-json --output-format=stream-json --verbose';
// Pre-approved toolset for the root fallback below.
const CAPABILITY_TOOLS = 'Bash Read Write Edit Glob Grep WebSearch WebFetch TodoWrite';

function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Flags that pre-authorize capability, so an unattended session never stalls
 * on a permission prompt nobody is there to answer.
 *
 * `--allow-dangerously-skip-permissions` is the intended lever, but Claude
 * Code refuses it (and bypassPermissions) under root/sudo, so on a root
 * runner we pre-approve the toolset instead — same "nothing blocks" result
 * through a mechanism the CLI accepts.
 */
export function permissionFlags(isRoot: boolean = runningAsRoot()): string {
  return isRoot
    ? `--permission-mode acceptEdits --allowedTools "${CAPABILITY_TOOLS}"`
    : '--allow-dangerously-skip-permissions --permission-mode bypassPermissions';
}

/** The default conversation profile, always available without configuration. */
export function conversationProfile(home: string = runnerHome()): LaunchProfile {
  const cwd = workspaceDir(home);
  fs.mkdirSync(cwd, { recursive: true });
  return {
    id: 'conversation',
    label: 'Conversation',
    kind: 'headless',
    cwd,
    command: `claude ${STREAM_JSON} ${ISOLATE_MCP} ${permissionFlags()}`,
    builtin: true,
  };
}

export function builtinProfiles(home: string = runnerHome()): LaunchProfile[] {
  return [conversationProfile(home)];
}

/**
 * Every launchable profile: the built-ins, plus the user's own from
 * profiles.json. A user profile with the same id replaces the built-in, so a
 * machine can override the defaults without losing the allowlist boundary.
 */
export function allProfiles(home: string = runnerHome()): LaunchProfile[] {
  const user = loadProfiles(home);
  const userIds = new Set(user.map((p) => p.id));
  return [...builtinProfiles(home).filter((p) => !userIds.has(p.id)), ...user];
}

export class ProfileExistsError extends Error {}

export interface CodeProfileOptions {
  id?: string;
  label?: string;
  kind?: SessionKind;
  /** Permission mode passed to Claude; defaults to acceptEdits. */
  permissionMode?: string;
  /** Isolate from this machine's MCP servers (off by default for code). */
  isolateMcp?: boolean;
}

/** Turn a directory name into a usable profile id, e.g. /repos/foo -> code-foo. */
function idForDir(dir: string): string {
  const base = path.basename(path.resolve(dir)).toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `code-${slug === '' ? 'session' : slug}`;
}

/**
 * Add a profile for working in a specific directory. Code sessions are
 * user-chosen — this only writes what the caller asked for, on the machine.
 */
export function addCodeProfile(
  dir: string,
  opts: CodeProfileOptions = {},
  home: string = runnerHome(),
): LaunchProfile {
  const cwd = path.resolve(dir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`not a directory: ${cwd}`);
  }
  const id = opts.id ?? idForDir(cwd);
  const existing = loadProfiles(home);
  if (existing.some((p) => p.id === id)) {
    throw new ProfileExistsError(`profile "${id}" already exists (pass --id to choose another)`);
  }
  const kind = opts.kind ?? 'headless';
  // Default auto: the session is driven remotely, so prompts would stall it.
  const permission = `--permission-mode ${opts.permissionMode ?? 'auto'}`;
  const mcp = opts.isolateMcp ? ` ${ISOLATE_MCP}` : '';
  const profile: LaunchProfile = {
    id,
    label: opts.label ?? `Code: ${path.basename(cwd)}`,
    kind,
    cwd,
    // tmux runs Claude interactively; headless speaks stream-json.
    command:
      kind === 'tmux' ? `claude ${permission}${mcp}` : `claude ${STREAM_JSON}${mcp} ${permission}`,
  };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    profilesPath(home),
    `${JSON.stringify({ profiles: [...existing, profile] }, null, 2)}\n`,
  );
  return profile;
}

/** Remove a user profile; returns false if there was no such id. */
export function removeProfile(id: string, home: string = runnerHome()): boolean {
  const existing = loadProfiles(home);
  const remaining = existing.filter((p) => p.id !== id);
  if (remaining.length === existing.length) return false;
  fs.writeFileSync(profilesPath(home), `${JSON.stringify({ profiles: remaining }, null, 2)}\n`);
  return true;
}
