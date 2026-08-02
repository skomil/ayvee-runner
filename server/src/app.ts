import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { requireApiKey } from './auth.js';
import type { ClaudeUsageProvider } from './claudeUsage.js';
import {
  ProfilesError,
  readApiKey,
  readPublicUrl,
  readRunnerId,
  readRunnerName,
  readTokenLimit,
} from './config.js';
import { allProfiles } from './profiles.js';
import {
  addRegistration,
  loadRegistrations,
  RegistrationError,
  removeRegistration,
} from './registrations.js';
import { SessionKindError, SessionNotFound, SessionRegistry } from './sessions/registry.js';

export const VERSION = '0.1.0';

export interface AppOptions {
  home: string;
  registry: SessionRegistry;
  /** Directory of built dashboard assets; omit to skip serving the UI. */
  publicDir?: string;
  /** Real limit usage from the Claude CLI; omit to report none. */
  claudeUsage?: ClaudeUsageProvider;
}

export function defaultPublicDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
}

export function createApp(opts: AppOptions): Express {
  const { home, registry } = opts;
  const startedAt = Date.now();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Health and metrics are anonymously readable — a status page for browsers
  // and proxies. They carry no secrets; everything else requires the key.
  api.get('/health', async (_req, res) => {
    const sessions = await registry.list();
    res.json({
      status: 'ok',
      name: readRunnerName(home),
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      sessions: {
        total: sessions.length,
        running: sessions.filter((s) => s.status === 'running').length,
      },
    });
  });

  api.get('/metrics', async (_req, res) => {
    res.json({
      claude: registry.usage.snapshot(Date.now(), readTokenLimit(home)),
      // What the Claude CLI itself reports — the authoritative "how much is
      // left", as opposed to tokens this runner happens to have metered.
      limits: (await opts.claudeUsage?.get()) ?? null,
    });
  });

  /**
   * Where this runner is reachable from outside. Prefers the configured
   * public URL (set it when proxied), else reconstructs from the request.
   */
  function baseUrl(req: Request): string {
    const configured = readPublicUrl(home);
    if (configured !== null) return configured;
    const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? req.protocol;
    const prefix = req.get('x-forwarded-prefix')?.replace(/\/*$/, '') ?? '';
    return `${proto}://${req.get('host')}${prefix}/`;
  }

  function descriptor(req: Request) {
    return {
      runnerId: readRunnerId(home),
      name: readRunnerName(home),
      version: VERSION,
      registerUrl: new URL('api/register', baseUrl(req)).toString(),
      capabilities: {
        sessionKinds: ['tmux', 'headless'],
        remoteControl: true,
        modelSelection: true,
        headlessInput: true,
        metrics: true,
        mcp: true,
      },
    };
  }

  // Advertised anonymously so an Ayvee server (or a human copying it into
  // Ayvee) can discover where and how to register. Identity and capabilities
  // only — no profiles, paths, commands, or session detail.
  api.get('/registration', (req, res) => {
    res.json(descriptor(req));
  });

  api.use(requireApiKey(() => readApiKey(home)));

  api.post('/register', (req, res) => {
    const { ayveeUrl, label } = (req.body ?? {}) as { ayveeUrl?: unknown; label?: unknown };
    if (typeof ayveeUrl !== 'string' || ayveeUrl.trim() === '') {
      res.status(400).json({ error: 'ayveeUrl is required' });
      return;
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      res.status(400).json({ error: 'label must be a string' });
      return;
    }
    const registration = addRegistration(ayveeUrl.trim(), label ?? null, home);
    res.status(201).json({ runner: descriptor(req), registration });
  });

  api.get('/registrations', (_req, res) => {
    res.json({ registrations: loadRegistrations(home) });
  });

  api.delete('/registrations/:id', (req, res) => {
    if (!removeRegistration(req.params.id, home)) {
      res.status(404).json({ error: `no registration with id ${req.params.id}` });
      return;
    }
    res.json({ ok: true });
  });

  api.get('/profiles', (_req, res) => {
    res.json({ profiles: allProfiles(home) });
  });

  api.get('/sessions', async (_req, res) => {
    res.json({ sessions: await registry.list() });
  });

  api.post('/sessions', async (req, res) => {
    const { profileId, name, remoteControl, model } = (req.body ?? {}) as {
      profileId?: unknown;
      name?: unknown;
      remoteControl?: unknown;
      model?: unknown;
    };
    if (typeof profileId !== 'string') {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    if (name !== undefined && typeof name !== 'string') {
      res.status(400).json({ error: 'name must be a string' });
      return;
    }
    if (remoteControl !== undefined && typeof remoteControl !== 'boolean') {
      res.status(400).json({ error: 'remoteControl must be a boolean' });
      return;
    }
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
      res.status(400).json({ error: 'model must be a non-empty string' });
      return;
    }
    const profile = allProfiles(home).find((p) => p.id === profileId);
    if (!profile) {
      res.status(400).json({ error: `unknown profile id "${profileId}"` });
      return;
    }
    res.status(201).json({
      session: await registry.spawn(profile, name, { remoteControl, model: model?.trim() }),
    });
  });

  api.get('/sessions/:id', async (req, res) => {
    res.json({ session: await registry.get(req.params.id) });
  });

  api.delete('/sessions/:id', async (req, res) => {
    res.json({ session: await registry.kill(req.params.id) });
  });

  api.post('/sessions/:id/input', (req, res) => {
    const { message } = (req.body ?? {}) as { message?: unknown };
    if (typeof message !== 'string' || message === '') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    registry.sendInput(req.params.id, message);
    res.status(202).json({ ok: true });
  });

  api.get('/sessions/:id/events', (req, res) => {
    const since = Number(req.query.since ?? 0);
    if (!Number.isInteger(since) || since < 0) {
      res.status(400).json({ error: 'since must be a non-negative integer' });
      return;
    }
    res.json({ events: registry.eventsSince(req.params.id, since) });
  });

  app.use('/api', api);

  if (opts.publicDir) {
    app.use(express.static(opts.publicDir));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SessionNotFound) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof SessionKindError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof RegistrationError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof ProfilesError) {
      res.status(500).json({ error: err.message });
    } else if ('type' in err && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'request body is not valid JSON' });
    } else {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
