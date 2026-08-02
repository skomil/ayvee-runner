import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, VERSION } from '../src/app.js';
import { ClaudeUsageProvider } from '../src/claudeUsage.js';
import { mintApiKey, profilesPath, setRunnerName, setTokenLimit } from '../src/config.js';
import { SessionRegistry } from '../src/sessions/registry.js';
import type { TmuxDriver } from '../src/sessions/tmux.js';

class FakeTmuxDriver implements TmuxDriver {
  alive = new Set<string>();
  async newSession(name: string): Promise<void> {
    this.alive.add(name);
  }
  async hasSession(name: string): Promise<boolean> {
    return this.alive.has(name);
  }
  async killSession(name: string): Promise<void> {
    this.alive.delete(name);
  }
}

let home: string;
let key: string;
let registry: SessionRegistry;
let app: ReturnType<typeof createApp>;

const PROFILES = {
  profiles: [
    { id: 'shell', label: 'Shell', kind: 'tmux', cwd: '/tmp', command: 'bash' },
    { id: 'echo', label: 'Echo agent', kind: 'headless', cwd: '/tmp', command: 'cat' },
  ],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr-app-'));
  key = mintApiKey(home);
  fs.writeFileSync(profilesPath(home), JSON.stringify(PROFILES));
  registry = new SessionRegistry(new FakeTmuxDriver());
  app = createApp({ home, registry });
});

afterEach(async () => {
  await registry.shutdown();
  fs.rmSync(home, { recursive: true, force: true });
});

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${key}`);
}

describe('auth on the API surface', () => {
  it('serves health and metrics anonymously', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const metrics = await request(app).get('/api/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body.claude.windowHours).toBe(5);
  });

  it('ignores a wrong key on the anonymous routes rather than failing', async () => {
    const res = await request(app).get('/api/health').set('Authorization', 'Bearer ayr_wrong');
    expect(res.status).toBe(200);
  });

  it('rejects requests without a key on every managed route', async () => {
    for (const [method, url] of [
      ['get', '/api/profiles'],
      ['get', '/api/sessions'],
      ['post', '/api/sessions'],
      ['get', '/api/sessions/x'],
      ['delete', '/api/sessions/x'],
      ['post', '/api/sessions/x/input'],
      ['get', '/api/sessions/x/events'],
    ] as const) {
      const res = await request(app)[method](url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it('does not fingerprint the server or allow caching of API responses', async () => {
    const res = await authed(request(app).get('/api/health'));
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    const denied = await request(app).get('/api/sessions');
    expect(denied.headers['x-powered-by']).toBeUndefined();
  });

  it('never echoes the expected key in a rejection', async () => {
    const res = await request(app).get('/api/sessions').set('Authorization', 'Bearer ayr_wrong');
    expect(JSON.stringify(res.body)).not.toContain(key);
  });

  it('honours a key rotation without restarting', async () => {
    expect((await authed(request(app).get('/api/sessions'))).status).toBe(200);
    const newKey = mintApiKey(home);
    expect((await authed(request(app).get('/api/sessions'))).status).toBe(401);
    const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${newKey}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/health', () => {
  it('reports version, uptime, and session counts', async () => {
    const res = await authed(request(app).get('/api/health'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(VERSION);
    expect(typeof res.body.name).toBe('string');
    expect(res.body.name).not.toBe('');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.sessions).toEqual({ total: 0, running: 0 });
  });

  it('reports the configured runner name', async () => {
    setRunnerName("scott's vm", home);
    const res = await authed(request(app).get('/api/health'));
    expect(res.body.name).toBe("scott's vm");
  });
});

describe('GET /api/metrics', () => {
  it('returns the usage snapshot with breakdown and limit', async () => {
    registry.usage.record({ input: 10, output: 5, cacheCreation: 20, cacheRead: 30 });
    const res = await authed(request(app).get('/api/metrics'));
    expect(res.status).toBe(200);
    expect(res.body.claude.windowHours).toBe(5);
    expect(res.body.claude.window).toEqual({
      input: 10,
      output: 5,
      cacheCreation: 20,
      cacheRead: 30,
      total: 65,
    });
    expect(res.body.claude.lifetime.total).toBe(65);
    expect(res.body.claude.limit).toEqual({
      tokens: null,
      usedPercent: null,
      remainingTokens: null,
      remainingPercent: null,
    });
  });

  it('reports no CLI limits when no provider is configured', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.body.limits).toBeNull();
  });

  it('includes the real limits the Claude CLI reports', async () => {
    const withLimits = createApp({
      home,
      registry,
      claudeUsage: new ClaudeUsageProvider(
        60_000,
        async () => 'Current session: 20% used · resets Aug 2, 4:09am (UTC)',
      ),
    });
    const res = await request(withLimits).get('/api/metrics');
    expect(res.body.limits.source).toBe('claude-cli');
    expect(res.body.limits.limits[0]).toMatchObject({
      scope: 'session',
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: 'Aug 2, 4:09am (UTC)',
    });
  });

  it('still serves metrics when the CLI lookup fails', async () => {
    const broken = createApp({
      home,
      registry,
      claudeUsage: new ClaudeUsageProvider(60_000, async () => {
        throw new Error('claude not installed');
      }),
    });
    const res = await request(broken).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.body.limits).toBeNull();
    expect(res.body.claude.windowHours).toBe(5);
  });

  it('reports how much of the configured limit is left, picking up changes live', async () => {
    registry.usage.record({ input: 10, output: 5, cacheCreation: 20, cacheRead: 30 });
    setTokenLimit(130, home);
    const res = await request(app).get('/api/metrics');
    expect(res.body.claude.limit).toEqual({
      tokens: 130,
      usedPercent: 50,
      remainingTokens: 65,
      remainingPercent: 50,
    });

    // No restart: raising the limit is reflected on the next request.
    setTokenLimit(260, home);
    const after = await request(app).get('/api/metrics');
    expect(after.body.claude.limit.remainingPercent).toBe(75);
  });
});

describe('GET /api/profiles', () => {
  it('returns the built-in conversation profile plus the user allowlist', async () => {
    const res = await authed(request(app).get('/api/profiles'));
    expect(res.status).toBe(200);
    const builtins = res.body.profiles.filter((p: { builtin?: boolean }) => p.builtin);
    expect(builtins.map((p: { id: string }) => p.id)).toEqual(['conversation']);
    expect(res.body.profiles.filter((p: { builtin?: boolean }) => !p.builtin)).toEqual(
      PROFILES.profiles,
    );
  });

  it('can spawn the built-in conversation profile without any profiles.json', async () => {
    fs.rmSync(profilesPath(home));
    const res = await authed(request(app).post('/api/sessions')).send({
      profileId: 'conversation',
    });
    expect(res.status).toBe(201);
    expect(res.body.session.kind).toBe('headless');
  });

  it('surfaces a malformed profiles.json as a 500', async () => {
    fs.writeFileSync(profilesPath(home), '{broken');
    const res = await authed(request(app).get('/api/profiles'));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/valid JSON/);
  });
});

describe('session lifecycle over the API', () => {
  it('spawns from a profile id, lists, gets, and kills', async () => {
    const spawn = await authed(request(app).post('/api/sessions')).send({ profileId: 'shell', name: 'work' });
    expect(spawn.status).toBe(201);
    const { session } = spawn.body;
    expect(session.name).toBe('work');
    expect(session.status).toBe('running');

    const list = await authed(request(app).get('/api/sessions'));
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual([session.id]);

    const got = await authed(request(app).get(`/api/sessions/${session.id}`));
    expect(got.body.session.id).toBe(session.id);

    const killed = await authed(request(app).delete(`/api/sessions/${session.id}`));
    expect(killed.body.session.status).toBe('exited');
    expect((await authed(request(app).get(`/api/sessions/${session.id}`))).status).toBe(404);
  });

  it('spawns with remoteControl on a tmux profile and reports the flag', async () => {
    const res = await authed(request(app).post('/api/sessions')).send({
      profileId: 'shell',
      name: 'rc',
      remoteControl: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.session.remoteControl).toBe(true);
  });

  it('rejects remoteControl on a headless profile and non-boolean values', async () => {
    const headless = await authed(request(app).post('/api/sessions')).send({
      profileId: 'echo',
      remoteControl: true,
    });
    expect(headless.status).toBe(400);
    expect(headless.body.error).toMatch(/tmux/);
    const bad = await authed(request(app).post('/api/sessions')).send({
      profileId: 'shell',
      remoteControl: 'yes',
    });
    expect(bad.status).toBe(400);
  });

  it('spawns with a model and reports it on the session', async () => {
    const res = await authed(request(app).post('/api/sessions')).send({
      profileId: 'echo',
      model: 'sonnet',
    });
    expect(res.status).toBe(201);
    expect(res.body.session.model).toBe('sonnet');
  });

  it('rejects an empty or non-string model', async () => {
    for (const model of ['', '   ', 42]) {
      const res = await authed(request(app).post('/api/sessions')).send({
        profileId: 'echo',
        model,
      });
      expect(res.status, String(model)).toBe(400);
    }
  });

  it('rejects an unknown profile id', async () => {
    const res = await authed(request(app).post('/api/sessions')).send({ profileId: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown profile/);
  });

  it('rejects a missing profileId and a non-string name', async () => {
    expect((await authed(request(app).post('/api/sessions')).send({})).status).toBe(400);
    expect(
      (await authed(request(app).post('/api/sessions')).send({ profileId: 'shell', name: 42 })).status,
    ).toBe(400);
  });

  it('rejects invalid JSON bodies', async () => {
    const res = await authed(request(app).post('/api/sessions'))
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(res.status).toBe(400);
  });

  it('404s on unknown session ids', async () => {
    expect((await authed(request(app).get('/api/sessions/nope'))).status).toBe(404);
    expect((await authed(request(app).delete('/api/sessions/nope'))).status).toBe(404);
    expect((await authed(request(app).post('/api/sessions/nope/input')).send({ message: 'x' })).status).toBe(404);
    expect((await authed(request(app).get('/api/sessions/nope/events'))).status).toBe(404);
  });
});

describe('headless input and events over the API', () => {
  it('dispatches input and reads it back as events with since-pagination', async () => {
    const spawn = await authed(request(app).post('/api/sessions')).send({ profileId: 'echo' });
    const id = spawn.body.session.id;

    const sent = await authed(request(app).post(`/api/sessions/${id}/input`)).send({ message: 'ping' });
    expect(sent.status).toBe(202);

    let events: { seq: number; data: unknown }[] = [];
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) {
      const res = await authed(request(app).get(`/api/sessions/${id}/events`));
      events = res.body.events;
      if (events.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { type: string }).type).toBe('user');

    const after = await authed(request(app).get(`/api/sessions/${id}/events?since=${events[0]!.seq}`));
    expect(after.body.events).toEqual([]);
  });

  it('rejects input to a tmux session and empty messages', async () => {
    const spawn = await authed(request(app).post('/api/sessions')).send({ profileId: 'shell' });
    const id = spawn.body.session.id;
    const res = await authed(request(app).post(`/api/sessions/${id}/input`)).send({ message: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/headless/);

    const echo = await authed(request(app).post('/api/sessions')).send({ profileId: 'echo' });
    const bad = await authed(request(app).post(`/api/sessions/${echo.body.session.id}/input`)).send({});
    expect(bad.status).toBe(400);
  });

  it('rejects a bad since parameter', async () => {
    const spawn = await authed(request(app).post('/api/sessions')).send({ profileId: 'echo' });
    const res = await authed(request(app).get(`/api/sessions/${spawn.body.session.id}/events?since=-2`));
    expect(res.status).toBe(400);
  });
});
