import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runnerHome } from './config.js';

export const REGISTRATIONS_FILE = 'registrations.json';

/** An Ayvee server that has registered itself with this runner. */
export interface Registration {
  id: string;
  ayveeUrl: string;
  label: string | null;
  registeredAt: string;
}

export class RegistrationError extends Error {}

export function registrationsPath(home: string = runnerHome()): string {
  return path.join(home, REGISTRATIONS_FILE);
}

export function loadRegistrations(home: string = runnerHome()): Registration[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registrationsPath(home), 'utf8'));
    const list = (parsed as { registrations?: unknown }).registrations;
    return Array.isArray(list) ? (list as Registration[]) : [];
  } catch {
    return [];
  }
}

function save(registrations: Registration[], home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(registrationsPath(home), `${JSON.stringify({ registrations }, null, 2)}\n`);
}

/**
 * Register an Ayvee server. Registering the same URL twice refreshes the
 * existing entry rather than duplicating it, so a retrying caller is safe.
 */
export function addRegistration(
  ayveeUrl: string,
  label: string | null,
  home: string = runnerHome(),
): Registration {
  let parsed: URL;
  try {
    parsed = new URL(ayveeUrl);
  } catch {
    throw new RegistrationError(`ayveeUrl is not a valid URL: ${ayveeUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RegistrationError('ayveeUrl must be http(s)');
  }
  const registrations = loadRegistrations(home);
  const existing = registrations.find((r) => r.ayveeUrl === ayveeUrl);
  const registration: Registration = {
    id: existing?.id ?? crypto.randomUUID(),
    ayveeUrl,
    label,
    registeredAt: new Date().toISOString(),
  };
  save(
    [...registrations.filter((r) => r.id !== registration.id), registration],
    home,
  );
  return registration;
}

/** Remove a registration; returns false if there was no such id. */
export function removeRegistration(id: string, home: string = runnerHome()): boolean {
  const registrations = loadRegistrations(home);
  const remaining = registrations.filter((r) => r.id !== id);
  if (remaining.length === registrations.length) return false;
  save(remaining, home);
  return true;
}
