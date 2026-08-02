import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { mintApiKey, readRunnerId, setPublicUrl, setRunnerName } from '../src/config.js';
import { addRegistration, loadRegistrations, RegistrationError } from '../src/registrations.js';
import { SessionRegistry } from '../src/sessions/registry.js';

let home: string;
let key: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr-reg-'));
  key = mintApiKey(home);
  app = createApp({ home, registry: new SessionRegistry() });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${key}`);
}

describe('runner identity', () => {
  it('generates a stable runner id and keeps it across reads', () => {
    const first = readRunnerId(home);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(readRunnerId(home)).toBe(first);
  });

  it('survives a rename', () => {
    const id = readRunnerId(home);
    setRunnerName("scott's laptop", home);
    expect(readRunnerId(home)).toBe(id);
  });
});

describe('GET /api/registration (advertised anonymously)', () => {
  it('advertises identity, capabilities, and the register URL', async () => {
    setRunnerName("scott's vm", home);
    const res = await request(app).get('/api/registration');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("scott's vm");
    expect(res.body.runnerId).toBe(readRunnerId(home));
    expect(res.body.registerUrl).toMatch(/\/api\/register$/);
    expect(res.body.capabilities).toMatchObject({
      sessionKinds: ['tmux', 'headless'],
      remoteControl: true,
      modelSelection: true,
    });
  });

  it('derives the register URL from the request host by default', async () => {
    const res = await request(app).get('/api/registration').set('Host', 'runner.local:9000');
    expect(res.body.registerUrl).toBe('http://runner.local:9000/api/register');
  });

  it('honours proxy forwarding headers', async () => {
    const res = await request(app)
      .get('/api/registration')
      .set('Host', 'example.com')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Prefix', '/runners/vm');
    expect(res.body.registerUrl).toBe('https://example.com/runners/vm/api/register');
  });

  it('prefers a configured public URL over the request', async () => {
    setPublicUrl('https://scott.example.com/runners/vm', home);
    const res = await request(app).get('/api/registration').set('Host', '127.0.0.1:7777');
    expect(res.body.registerUrl).toBe('https://scott.example.com/runners/vm/api/register');
  });

  it('leaks no profile, path, or session detail', async () => {
    const res = await request(app).get('/api/registration');
    for (const forbidden of ['cwd', 'command', 'profileId', 'tmuxName']) {
      expect(JSON.stringify(res.body)).not.toContain(forbidden);
    }
  });
});

describe('POST /api/register', () => {
  it('requires the API key', async () => {
    const res = await request(app).post('/api/register').send({ ayveeUrl: 'https://ayvee.ai' });
    expect(res.status).toBe(401);
    expect(loadRegistrations(home)).toEqual([]);
  });

  it('registers an Ayvee server and returns the runner descriptor', async () => {
    const res = await authed(request(app).post('/api/register')).send({
      ayveeUrl: 'https://ayvee.ai',
      label: 'prod',
    });
    expect(res.status).toBe(201);
    expect(res.body.registration).toMatchObject({ ayveeUrl: 'https://ayvee.ai', label: 'prod' });
    expect(res.body.runner.runnerId).toBe(readRunnerId(home));
    expect(loadRegistrations(home)).toHaveLength(1);
  });

  it('is idempotent for the same Ayvee URL', async () => {
    const first = await authed(request(app).post('/api/register')).send({
      ayveeUrl: 'https://ayvee.ai',
    });
    const second = await authed(request(app).post('/api/register')).send({
      ayveeUrl: 'https://ayvee.ai',
      label: 'renamed',
    });
    expect(second.body.registration.id).toBe(first.body.registration.id);
    const stored = loadRegistrations(home);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.label).toBe('renamed');
  });

  it('rejects a missing, non-URL, or non-http ayveeUrl', async () => {
    for (const ayveeUrl of [undefined, '', 'not a url', 'file:///etc/passwd']) {
      const res = await authed(request(app).post('/api/register')).send({ ayveeUrl });
      expect(res.status, String(ayveeUrl)).toBe(400);
    }
    expect(loadRegistrations(home)).toEqual([]);
  });

  it('rejects a non-string label', async () => {
    const res = await authed(request(app).post('/api/register')).send({
      ayveeUrl: 'https://ayvee.ai',
      label: 42,
    });
    expect(res.status).toBe(400);
  });
});

describe('registrations list and removal', () => {
  it('lists and removes registrations, and 404s on unknown ids', async () => {
    const created = await authed(request(app).post('/api/register')).send({
      ayveeUrl: 'https://ayvee.ai',
    });
    const id = created.body.registration.id;

    const list = await authed(request(app).get('/api/registrations'));
    expect(list.body.registrations.map((r: { id: string }) => r.id)).toEqual([id]);

    expect((await authed(request(app).delete(`/api/registrations/${id}`))).status).toBe(200);
    expect((await authed(request(app).get('/api/registrations'))).body.registrations).toEqual([]);
    expect((await authed(request(app).delete(`/api/registrations/${id}`))).status).toBe(404);
  });

  it('requires the key to list or remove', async () => {
    expect((await request(app).get('/api/registrations')).status).toBe(401);
    expect((await request(app).delete('/api/registrations/x')).status).toBe(401);
  });

  it('persists across app instances (a runner restart)', async () => {
    addRegistration('https://ayvee.ai', 'from disk', home);
    const fresh = createApp({ home, registry: new SessionRegistry() });
    const res = await request(fresh)
      .get('/api/registrations')
      .set('Authorization', `Bearer ${key}`);
    expect(res.body.registrations[0].label).toBe('from disk');
  });
});

describe('addRegistration', () => {
  it('rejects invalid URLs at the store level', () => {
    expect(() => addRegistration('nope', null, home)).toThrow(RegistrationError);
    expect(() => addRegistration('ftp://ayvee.ai', null, home)).toThrow(/http/);
  });
});
