import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const MCP_SERVER_NAME = 'ayvee-runner';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * MCP server exposing the runner's operations as tools. It proxies to the
 * running HTTP API rather than owning sessions itself, so MCP callers and
 * API/dashboard callers always see the same state.
 */
export function createMcpServer(baseUrl: string, apiKey: string, version: string): McpServer {
  async function call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`/api${path}`, baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(json.error ?? `runner responded ${res.status}`);
    }
    return json;
  }

  function asResult(fn: () => Promise<unknown>): Promise<ToolResult> {
    return fn().then(
      (data) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }),
      (err: Error) => ({
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      }),
    );
  }

  const server = new McpServer({ name: MCP_SERVER_NAME, version });

  server.registerTool(
    'health',
    { description: "The runner's health: status, version, uptime, session counts." },
    () => asResult(() => call('GET', '/health')),
  );

  server.registerTool(
    'metrics',
    {
      description:
        'Claude token usage: totals in the rolling 5-hour limit window and lifetime, broken down by uncached input, output, cache write, and cache read, with percent of the configured 5-hour limit.',
    },
    () => asResult(() => call('GET', '/metrics')),
  );

  server.registerTool(
    'list_profiles',
    { description: 'The launch-profile allowlist sessions can be spawned from.' },
    () => asResult(() => call('GET', '/profiles')),
  );

  server.registerTool(
    'list_sessions',
    { description: 'List active sessions (tmux and headless) with liveness.' },
    () => asResult(() => call('GET', '/sessions')),
  );

  server.registerTool(
    'create_session',
    {
      description: 'Spawn a session from a launch-profile id (see list_profiles).',
      inputSchema: {
        profileId: z.string().describe('Id of an allowlisted launch profile'),
        name: z.string().optional().describe('Display name for the session'),
        remoteControl: z
          .boolean()
          .optional()
          .describe(
            'tmux profiles only: run `claude --remote-control` in the session so it appears as a Remote Control target on claude.ai',
          ),
        model: z
          .string()
          .optional()
          .describe(
            'Claude model for the session (e.g. "sonnet", "claude-opus-5"); exported as ANTHROPIC_MODEL',
          ),
      },
    },
    ({ profileId, name, remoteControl, model }) =>
      asResult(() => call('POST', '/sessions', { profileId, name, remoteControl, model })),
  );

  server.registerTool(
    'get_session',
    {
      description: 'Fetch one session by id, refreshing its liveness.',
      inputSchema: { sessionId: z.string() },
    },
    ({ sessionId }) => asResult(() => call('GET', `/sessions/${sessionId}`)),
  );

  server.registerTool(
    'kill_session',
    {
      description: 'Kill a session (tmux kill-session or SIGTERM for headless).',
      inputSchema: { sessionId: z.string() },
    },
    ({ sessionId }) => asResult(() => call('DELETE', `/sessions/${sessionId}`)),
  );

  server.registerTool(
    'send_input',
    {
      description: 'Dispatch one user turn to a headless session (stream-json).',
      inputSchema: { sessionId: z.string(), message: z.string() },
    },
    ({ sessionId, message }) =>
      asResult(() => call('POST', `/sessions/${sessionId}/input`, { message })),
  );

  server.registerTool(
    'get_events',
    {
      description: 'Read stream-json output events from a headless session.',
      inputSchema: {
        sessionId: z.string(),
        since: z.number().int().min(0).optional().describe('Only events after this seq'),
      },
    },
    ({ sessionId, since }) =>
      asResult(() =>
        call('GET', `/sessions/${sessionId}/events`, undefined, {
          since: String(since ?? 0),
        }),
      ),
  );

  return server;
}
