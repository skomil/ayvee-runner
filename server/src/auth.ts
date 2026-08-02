import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Constant-time comparison of a presented key against the expected one. */
export function keysMatch(presented: string, expected: string): boolean {
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match ? (match[1] ?? null) : null;
}

/**
 * Guard for /api routes. `getKey` re-reads the key from disk on each request
 * so a rotation via `ayvee-runner mint-key` takes effect without a restart.
 */
export function requireApiKey(getKey: () => string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = getKey();
    if (expected === null) {
      res.status(503).json({ error: 'no API key minted; run: ayvee-runner mint-key' });
      return;
    }
    const presented = extractBearer(req.headers.authorization);
    if (presented === null || !keysMatch(presented, expected)) {
      res.status(401).json({ error: 'invalid or missing API key' });
      return;
    }
    next();
  };
}
