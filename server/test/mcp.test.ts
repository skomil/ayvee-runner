import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, VERSION } from '../src/app.js';
import { mintApiKey, profilesPath, setTokenLimit } from '../src/config.js';
import { createMcpServer } from '../src/mcp.js';
import { SessionRegistry } from '../src/sessions/registry.js';

// A headless command that emits one assistant event carrying usage, then
// echoes input lines — enough to exercise metrics, input, and events.
const USAGE_EVENT = JSON.stringify({
  type: 'assistant',
  message: {
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    },
  },
});
const AGENT_CMD = `echo '${USAGE_EVENT}' && cat`;

let home: string;
let httpServer: Server;
let registry: SessionRegistry;
let client: Client;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toolJson(name: string, args?: Record<string, unknown>): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text);
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ayr-mcp-'));
  const key = mintApiKey(home);
  fs.writeFileSync(
    profilesPath(home),
    JSON.stringify({
      profiles: [{ id: 'agent', label: 'Agent', kind: 'headless', cwd: '/tmp', command: AGENT_CMD }],
    }),
  );
  setTokenLimit(6500, home);
  registry = new SessionRegistry();
  const app = createApp({ home, registry });
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const { port } = httpServer.address() as { port: number };

  const mcpServer = createMcpServer(`http://127.0.0.1:${port}`, key, VERSION);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await registry.shutdown();
  httpServer.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes a tool for every API operation', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_session',
      'get_events',
      'get_session',
      'health',
      'kill_session',
      'list_profiles',
      'list_sessions',
      'metrics',
      'send_input',
    ]);
  });

  it('reports health and the profile allowlist', async () => {
    const health = await toolJson('health');
    expect(health.status).toBe('ok');
    const { profiles } = await toolJson('list_profiles');
    expect(profiles.map((p: { id: string }) => p.id)).toEqual(['conversation', 'agent']);
  });

  it('drives a full session lifecycle: create, input, events, metrics, kill', async () => {
    const { session } = await toolJson('create_session', { profileId: 'agent', name: 'via mcp' });
    expect(session.name).toBe('via mcp');
    expect(session.status).toBe('running');

    const listed = await toolJson('list_sessions');
    expect(listed.sessions.map((s: { id: string }) => s.id)).toContain(session.id);
    expect((await toolJson('get_session', { sessionId: session.id })).session.id).toBe(session.id);

    await toolJson('send_input', { sessionId: session.id, message: 'over mcp' });
    let events: Array<{ seq: number; data: { type?: string } }> = [];
    const deadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < deadline) {
      events = (await toolJson('get_events', { sessionId: session.id })).events;
      if (events.length < 2) await new Promise((r) => setTimeout(r, 25));
    }
    expect(events[0]!.data.type).toBe('assistant');
    expect(events[1]!.data.type).toBe('user');
    const paged = await toolJson('get_events', { sessionId: session.id, since: events[1]!.seq });
    expect(paged.events).toEqual([]);

    const { claude } = await toolJson('metrics');
    expect(claude.window).toEqual({ input: 10, output: 5, cacheCreation: 20, cacheRead: 30, total: 65 });
    expect(claude.limit).toEqual({
      tokens: 6500,
      usedPercent: 1,
      remainingTokens: 6435,
      remainingPercent: 99,
    });

    const killed = await toolJson('kill_session', { sessionId: session.id });
    expect(killed.session.status).toBe('exited');
    expect((await toolJson('list_sessions')).sessions).toEqual([]);
  });

  it('surfaces API errors as MCP tool errors', async () => {
    const result = (await client.callTool({
      name: 'get_session',
      arguments: { sessionId: 'nope' },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no session/);
  });
});
