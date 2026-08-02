import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { extractBearer, keysMatch, requireApiKey } from '../src/auth.js';

describe('extractBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
  });

  it('returns null for missing or malformed headers', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('Basic abc123')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
  });
});

describe('keysMatch', () => {
  it('matches equal keys and rejects different ones, regardless of length', () => {
    expect(keysMatch('ayr_secret', 'ayr_secret')).toBe(true);
    expect(keysMatch('ayr_secret', 'ayr_other')).toBe(false);
    expect(keysMatch('short', 'a-much-longer-key-value')).toBe(false);
  });
});

describe('requireApiKey middleware', () => {
  function appWithKey(key: string | null) {
    const app = express();
    app.use(requireApiKey(() => key));
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('returns 503 when no key has been minted', async () => {
    const res = await request(appWithKey(null)).get('/ping').set('Authorization', 'Bearer x');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/mint-key/);
  });

  it('returns 401 without a key', async () => {
    const res = await request(appWithKey('ayr_k')).get('/ping');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong key', async () => {
    const res = await request(appWithKey('ayr_k')).get('/ping').set('Authorization', 'Bearer ayr_wrong');
    expect(res.status).toBe(401);
  });

  it('passes with the right key', async () => {
    const res = await request(appWithKey('ayr_k')).get('/ping').set('Authorization', 'Bearer ayr_k');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
