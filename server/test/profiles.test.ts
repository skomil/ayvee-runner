import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profilesPath } from '../src/config.js';
import {
  addCodeProfile,
  allProfiles,
  conversationProfile,
  permissionFlags,
  ProfileExistsError,
  removeProfile,
  workspaceDir,
} from '../src/profiles.js';

let home: string;
let repo: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr-prof-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foo-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('the built-in conversation profile', () => {
  it('is available with no configuration at all', () => {
    const profiles = allProfiles(home);
    expect(profiles.map((p) => p.id)).toEqual(['conversation']);
    expect(profiles[0]!.builtin).toBe(true);
    expect(profiles[0]!.kind).toBe('headless');
  });

  it('isolates MCP so it never inherits the machine servers', () => {
    const { command } = conversationProfile(home);
    expect(command).toContain('--strict-mcp-config');
    expect(command).toContain(`--mcp-config '{"mcpServers":{}}'`);
  });

  it('pre-authorizes capability so a tool call never stalls on a prompt', () => {
    const { command } = conversationProfile(home);
    // Whichever branch applies, the session must not be able to block.
    expect(command).toMatch(/--allow-dangerously-skip-permissions|--permission-mode/);
  });
});

describe('permission flags', () => {
  it('uses --allow-dangerously-skip-permissions when not running as root', () => {
    expect(permissionFlags(false)).toBe(
      '--allow-dangerously-skip-permissions --permission-mode bypassPermissions',
    );
  });

  it('falls back to a pre-approved toolset under root, which the CLI refuses the flag for', () => {
    const flags = permissionFlags(true);
    expect(flags).not.toContain('dangerously');
    expect(flags).toContain('--permission-mode acceptEdits');
    // Bash must be pre-approved, or an unattended turn stalls on its prompt.
    const allowed = /--allowedTools "([^"]+)"/.exec(flags)![1]!.split(/\s+/);
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('Read');
  });

  it('speaks stream-json so turns can be dispatched', () => {
    expect(conversationProfile(home).command).toContain('--input-format=stream-json');
  });

  it('runs in a scratch workspace that it creates', () => {
    const profile = conversationProfile(home);
    expect(profile.cwd).toBe(workspaceDir(home));
    expect(fs.existsSync(profile.cwd)).toBe(true);
  });
});

describe('merging built-ins with the user allowlist', () => {
  function writeUser(profiles: unknown[]): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(profilesPath(home), JSON.stringify({ profiles }));
  }

  it('lists built-ins first, then the user profiles', () => {
    writeUser([{ id: 'mine', label: 'Mine', kind: 'tmux', cwd: '/tmp', command: 'bash' }]);
    expect(allProfiles(home).map((p) => p.id)).toEqual(['conversation', 'mine']);
  });

  it('lets a user profile override a built-in of the same id', () => {
    writeUser([
      { id: 'conversation', label: 'My conversation', kind: 'tmux', cwd: '/tmp', command: 'bash' },
    ]);
    const profiles = allProfiles(home);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.label).toBe('My conversation');
    expect(profiles[0]!.builtin).toBeUndefined();
  });
});

describe('config code', () => {
  it('derives an id and label from the directory', () => {
    const profile = addCodeProfile(repo, {}, home);
    expect(profile.id).toBe(`code-${path.basename(repo).toLowerCase()}`);
    expect(profile.label).toBe(`Code: ${path.basename(repo)}`);
    expect(profile.cwd).toBe(path.resolve(repo));
  });

  it('writes a headless stream-json command defaulting to auto permissions', () => {
    const { command, kind } = addCodeProfile(repo, {}, home);
    expect(kind).toBe('headless');
    expect(command).toContain('--input-format=stream-json');
    // auto keeps a remotely-driven session from stalling on a prompt.
    expect(command).toContain('--permission-mode auto');
    // Code sessions keep the repo's own MCP servers unless asked otherwise.
    expect(command).not.toContain('--strict-mcp-config');
  });

  it('honours --tmux, --permission-mode, --isolate-mcp, --id and --label', () => {
    const profile = addCodeProfile(
      repo,
      {
        id: 'work',
        label: 'Work',
        kind: 'tmux',
        permissionMode: 'bypassPermissions',
        isolateMcp: true,
      },
      home,
    );
    expect(profile).toMatchObject({ id: 'work', label: 'Work', kind: 'tmux' });
    expect(profile.command).toContain('--permission-mode bypassPermissions');
    expect(profile.command).toContain('--strict-mcp-config');
    expect(profile.command).not.toContain('--input-format'); // interactive
  });

  it('persists to profiles.json and shows up as launchable', () => {
    addCodeProfile(repo, { id: 'work' }, home);
    expect(allProfiles(home).map((p) => p.id)).toEqual(['conversation', 'work']);
    expect(JSON.parse(fs.readFileSync(profilesPath(home), 'utf8')).profiles).toHaveLength(1);
  });

  it('refuses a duplicate id and a missing directory', () => {
    addCodeProfile(repo, { id: 'work' }, home);
    expect(() => addCodeProfile(repo, { id: 'work' }, home)).toThrow(ProfileExistsError);
    expect(() => addCodeProfile('/no/such/dir', {}, home)).toThrow(/not a directory/);
  });
});

describe('config remove', () => {
  it('removes a user profile but reports built-ins as not removable', () => {
    addCodeProfile(repo, { id: 'work' }, home);
    expect(removeProfile('work', home)).toBe(true);
    expect(allProfiles(home).map((p) => p.id)).toEqual(['conversation']);
    expect(removeProfile('conversation', home)).toBe(false);
  });
});
