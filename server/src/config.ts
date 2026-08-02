import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchProfile } from './types.js';

export const API_KEY_FILE = 'api-key';
export const PROFILES_FILE = 'profiles.json';
export const CONFIG_FILE = 'config.json';

/** Directory holding the runner's on-disk state (API key, launch profiles). */
export function runnerHome(): string {
  return process.env.AYVEE_RUNNER_HOME ?? path.join(os.homedir(), '.ayvee-runner');
}

export function apiKeyPath(home: string = runnerHome()): string {
  return path.join(home, API_KEY_FILE);
}

export function profilesPath(home: string = runnerHome()): string {
  return path.join(home, PROFILES_FILE);
}

/**
 * Generate a fresh API key and write it to disk (0600), replacing any
 * previous key. Returns the plaintext key so the CLI can print it once for
 * the user to copy into the Ayvee server.
 */
export function mintApiKey(home: string = runnerHome()): string {
  const key = `ayr_${crypto.randomBytes(32).toString('base64url')}`;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(apiKeyPath(home), `${key}\n`, { mode: 0o600 });
  return key;
}

/** Read the current API key, or null if none has been minted yet. */
export function readApiKey(home: string = runnerHome()): string | null {
  try {
    const key = fs.readFileSync(apiKeyPath(home), 'utf8').trim();
    return key === '' ? null : key;
  } catch {
    return null;
  }
}

export function configPath(home: string = runnerHome()): string {
  return path.join(home, CONFIG_FILE);
}

function readConfig(home: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The human-readable name identifying this runner machine (e.g. "scott's vm").
 * Precedence: AYVEE_RUNNER_NAME env var, then config.json, then the hostname.
 */
export function readRunnerName(home: string = runnerHome()): string {
  const fromEnv = process.env.AYVEE_RUNNER_NAME?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = readConfig(home).name;
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim();
  return os.hostname();
}

/** Persist the runner name in config.json, preserving other config keys. */
export function setRunnerName(name: string, home: string = runnerHome()): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('runner name must not be empty');
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = { ...readConfig(home), name: trimmed };
  fs.writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
  return trimmed;
}

/**
 * Stable id for this runner, generated once and persisted, so an Ayvee server
 * keeps recognising the machine across restarts and renames.
 */
export function readRunnerId(home: string = runnerHome()): string {
  const existing = readConfig(home).runnerId;
  if (typeof existing === 'string' && existing !== '') return existing;
  const runnerId = crypto.randomUUID();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    configPath(home),
    `${JSON.stringify({ ...readConfig(home), runnerId }, null, 2)}\n`,
  );
  return runnerId;
}

/**
 * Externally reachable base URL, used when advertising the registration URL
 * (the listen address is loopback, so a proxied deployment must say where it
 * really lives). Null means "derive it from the incoming request".
 */
export function readPublicUrl(home: string = runnerHome()): string | null {
  const fromEnv = process.env.AYVEE_RUNNER_PUBLIC_URL?.trim();
  const raw = fromEnv && fromEnv !== '' ? fromEnv : readConfig(home).publicUrl;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim().replace(/\/*$/, '/'); // exactly one trailing slash
}

/** Persist the externally reachable base URL. */
export function setPublicUrl(url: string, home: string = runnerHome()): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('public URL must be http(s)');
  }
  const normalised = url.trim().replace(/\/*$/, '/');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    configPath(home),
    `${JSON.stringify({ ...readConfig(home), publicUrl: normalised }, null, 2)}\n`,
  );
  return normalised;
}

/**
 * The plan's 5-hour token limit used to compute how much is left.
 * Precedence: AYVEE_RUNNER_5H_TOKEN_LIMIT, then config.json, then unset.
 */
export function readTokenLimit(home: string = runnerHome()): number | null {
  const fromEnv = Number(process.env.AYVEE_RUNNER_5H_TOKEN_LIMIT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromConfig = readConfig(home).tokenLimit;
  return typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0
    ? fromConfig
    : null;
}

/** Persist the 5-hour token limit in config.json. */
export function setTokenLimit(tokens: number, home: string = runnerHome()): number {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new Error('token limit must be a positive number');
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = { ...readConfig(home), tokenLimit: tokens };
  fs.writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
  return tokens;
}

export class ProfilesError extends Error {}

/**
 * Load the launch-profile allowlist from profiles.json. A missing file is an
 * empty allowlist; a malformed one is an error (a typo must not silently
 * disable the security boundary).
 */
export function loadProfiles(home: string = runnerHome()): LaunchProfile[] {
  let raw: string;
  try {
    raw = fs.readFileSync(profilesPath(home), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfilesError(`${profilesPath(home)} is not valid JSON`);
  }
  const list = (parsed as { profiles?: unknown }).profiles;
  if (!Array.isArray(list)) {
    throw new ProfilesError(`${profilesPath(home)} must contain a "profiles" array`);
  }
  const seen = new Set<string>();
  return list.map((p, i) => {
    const prof = p as Partial<LaunchProfile>;
    if (
      typeof prof.id !== 'string' ||
      typeof prof.label !== 'string' ||
      (prof.kind !== 'tmux' && prof.kind !== 'headless') ||
      typeof prof.cwd !== 'string' ||
      typeof prof.command !== 'string'
    ) {
      throw new ProfilesError(
        `profile at index ${i} must have id, label, kind ("tmux"|"headless"), cwd, command`,
      );
    }
    if (seen.has(prof.id)) {
      throw new ProfilesError(`duplicate profile id "${prof.id}"`);
    }
    seen.add(prof.id);
    return {
      id: prof.id,
      label: prof.label,
      kind: prof.kind,
      cwd: prof.cwd,
      command: prof.command,
    };
  });
}
