import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiKeyPath,
  configPath,
  loadProfiles,
  mintApiKey,
  ProfilesError,
  profilesPath,
  readApiKey,
  readRunnerName,
  readTokenLimit,
  setRunnerName,
  setTokenLimit,
} from '../src/config.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr-test-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('api key', () => {
  it('is null before minting', () => {
    expect(readApiKey(home)).toBeNull();
  });

  it('mints a readable key with the ayr_ prefix', () => {
    const key = mintApiKey(home);
    expect(key).toMatch(/^ayr_[A-Za-z0-9_-]{43}$/);
    expect(readApiKey(home)).toBe(key);
  });

  it('stores the key file with owner-only permissions', () => {
    mintApiKey(home);
    const mode = fs.statSync(apiKeyPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rotation replaces the previous key', () => {
    const first = mintApiKey(home);
    const second = mintApiKey(home);
    expect(second).not.toBe(first);
    expect(readApiKey(home)).toBe(second);
  });

  it('treats an empty key file as unminted', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(apiKeyPath(home), '\n');
    expect(readApiKey(home)).toBeNull();
  });
});

describe('runner name', () => {
  it('defaults to the hostname when unconfigured', () => {
    expect(readRunnerName(home)).toBe(os.hostname());
  });

  it('set-name persists and read returns it trimmed', () => {
    setRunnerName("  scott's vm  ", home);
    expect(readRunnerName(home)).toBe("scott's vm");
  });

  it('rejects an empty name', () => {
    expect(() => setRunnerName('   ', home)).toThrow(/empty/);
  });

  it('preserves unrelated config keys when renaming', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(configPath(home), JSON.stringify({ other: 42 }));
    setRunnerName("scott's laptop", home);
    expect(JSON.parse(fs.readFileSync(configPath(home), 'utf8'))).toEqual({
      other: 42,
      name: "scott's laptop",
    });
  });

  it('prefers the AYVEE_RUNNER_NAME env var over config.json', () => {
    setRunnerName('from config', home);
    process.env.AYVEE_RUNNER_NAME = 'from env';
    try {
      expect(readRunnerName(home)).toBe('from env');
    } finally {
      delete process.env.AYVEE_RUNNER_NAME;
    }
  });

  it('ignores a corrupt config.json and falls back to the hostname', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(configPath(home), '{nope');
    expect(readRunnerName(home)).toBe(os.hostname());
  });
});

describe('5-hour token limit', () => {
  it('is null when unconfigured', () => {
    expect(readTokenLimit(home)).toBeNull();
  });

  it('set-limit persists and reads back, alongside the name', () => {
    setRunnerName("scott's vm", home);
    setTokenLimit(2_000_000, home);
    expect(readTokenLimit(home)).toBe(2_000_000);
    expect(readRunnerName(home)).toBe("scott's vm");
  });

  it('rejects a non-positive limit', () => {
    expect(() => setTokenLimit(0, home)).toThrow(/positive/);
    expect(() => setTokenLimit(-1, home)).toThrow(/positive/);
  });

  it('prefers the env var and ignores junk values', () => {
    setTokenLimit(1000, home);
    process.env.AYVEE_RUNNER_5H_TOKEN_LIMIT = '5000';
    try {
      expect(readTokenLimit(home)).toBe(5000);
      process.env.AYVEE_RUNNER_5H_TOKEN_LIMIT = 'lots';
      expect(readTokenLimit(home)).toBe(1000);
    } finally {
      delete process.env.AYVEE_RUNNER_5H_TOKEN_LIMIT;
    }
  });
});

describe('loadProfiles', () => {
  const valid = {
    id: 'dev',
    label: 'Dev shell',
    kind: 'tmux',
    cwd: '/tmp',
    command: 'bash',
  };

  function writeProfiles(content: unknown): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(profilesPath(home), typeof content === 'string' ? content : JSON.stringify(content));
  }

  it('returns an empty allowlist when the file is missing', () => {
    expect(loadProfiles(home)).toEqual([]);
  });

  it('parses valid profiles', () => {
    writeProfiles({ profiles: [valid] });
    expect(loadProfiles(home)).toEqual([valid]);
  });

  it('rejects invalid JSON', () => {
    writeProfiles('{nope');
    expect(() => loadProfiles(home)).toThrow(ProfilesError);
  });

  it('rejects a missing profiles array', () => {
    writeProfiles({ launch: [] });
    expect(() => loadProfiles(home)).toThrow(/"profiles" array/);
  });

  it('rejects a profile with a bad kind', () => {
    writeProfiles({ profiles: [{ ...valid, kind: 'docker' }] });
    expect(() => loadProfiles(home)).toThrow(/kind/);
  });

  it('rejects a profile missing a field', () => {
    const { command: _command, ...rest } = valid;
    writeProfiles({ profiles: [rest] });
    expect(() => loadProfiles(home)).toThrow(ProfilesError);
  });

  it('rejects duplicate profile ids', () => {
    writeProfiles({ profiles: [valid, { ...valid, label: 'other' }] });
    expect(() => loadProfiles(home)).toThrow(/duplicate/);
  });
});
