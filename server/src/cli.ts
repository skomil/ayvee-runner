#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp, defaultPublicDir, VERSION } from './app.js';
import { ClaudeUsageProvider } from './claudeUsage.js';
import {
  apiKeyPath,
  configPath,
  loadProfiles,
  mintApiKey,
  readApiKey,
  readPublicUrl,
  readRunnerId,
  readRunnerName,
  readTokenLimit,
  runnerHome,
  setPublicUrl,
  setRunnerName,
  setTokenLimit,
} from './config.js';
import { createMcpServer } from './mcp.js';
import { SessionRegistry } from './sessions/registry.js';

const USAGE = `ayvee-runner ${VERSION}

Usage:
  ayvee-runner mint-key          Mint (or rotate) the API key and print it once.
  ayvee-runner set-name <name>   Name this runner machine (e.g. "scott's vm") so
                                 you can tell servers apart from Ayvee.
  ayvee-runner set-limit <n>     Your plan's 5-hour token limit, so the dashboard
                                 can show how much of it is left.
  ayvee-runner set-url <url>     Externally reachable base URL (behind a proxy),
                                 used when advertising the registration URL.
  ayvee-runner serve [--port N]  Start the runner on 127.0.0.1 (default port 7777).
  ayvee-runner mcp [--url U]     MCP stdio server proxying to a running runner
                                 (default http://127.0.0.1:7777, key from disk).
`;

function mintKey(): void {
  const home = runnerHome();
  const key = mintApiKey(home);
  console.log(`New API key (stored at ${apiKeyPath(home)}):\n`);
  console.log(`  ${key}\n`);
  console.log('Copy it into the Ayvee server now — it replaces any previous key.');
}

function serve(args: string[]): void {
  const home = runnerHome();
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? Number(args[portIdx + 1]) : Number(process.env.AYVEE_RUNNER_PORT ?? 7777);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`invalid port: ${args[portIdx + 1]}`);
    process.exit(1);
  }
  if (readApiKey(home) === null) {
    console.warn('warning: no API key minted yet — all API requests will fail (run: ayvee-runner mint-key)');
  }
  const profiles = loadProfiles(home); // fail fast on a malformed profiles.json
  const registry = new SessionRegistry();
  // `AYVEE_RUNNER_CLAUDE_USAGE=off` skips shelling out to the Claude CLI.
  const claudeUsage =
    process.env.AYVEE_RUNNER_CLAUDE_USAGE === 'off' ? undefined : new ClaudeUsageProvider();
  const app = createApp({ home, registry, publicDir: defaultPublicDir(), claudeUsage });
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`ayvee-runner ${VERSION} ("${readRunnerName(home)}") listening on http://127.0.0.1:${port}`);
    const limit = readTokenLimit(home);
    console.log(`home: ${home} (${profiles.length} launch profile${profiles.length === 1 ? '' : 's'})`);
    console.log(
      limit === null
        ? '5-hour token limit: not set (run: ayvee-runner set-limit <tokens>)'
        : `5-hour token limit: ${limit.toLocaleString()} tokens`,
    );
    const base = readPublicUrl(home) ?? `http://127.0.0.1:${port}/`;
    console.log(`runner id: ${readRunnerId(home)}`);
    console.log(`register at: ${new URL('api/register', base).toString()}`);
  });

  const shutdown = async () => {
    await registry.shutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function mcp(args: string[]): Promise<void> {
  const urlIdx = args.indexOf('--url');
  const url =
    (urlIdx !== -1 ? args[urlIdx + 1] : undefined) ??
    process.env.AYVEE_RUNNER_URL ??
    `http://127.0.0.1:${process.env.AYVEE_RUNNER_PORT ?? 7777}`;
  const key = readApiKey(runnerHome());
  if (key === null) {
    console.error('no API key on disk; run: ayvee-runner mint-key');
    process.exit(1);
  }
  const server = createMcpServer(url, key, VERSION);
  await server.connect(new StdioServerTransport());
}

function setName(args: string[]): void {
  const name = args.join(' ').trim();
  if (name === '') {
    console.error('usage: ayvee-runner set-name <name>');
    process.exit(1);
  }
  const home = runnerHome();
  setRunnerName(name, home);
  console.log(`Runner name set to "${name}" (stored at ${configPath(home)}).`);
}

function setLimit(args: string[]): void {
  const tokens = Number((args[0] ?? '').replaceAll(/[_,]/g, ''));
  if (!Number.isFinite(tokens) || tokens <= 0) {
    console.error('usage: ayvee-runner set-limit <tokens>   (e.g. set-limit 2000000)');
    process.exit(1);
  }
  const home = runnerHome();
  setTokenLimit(tokens, home);
  console.log(
    `5-hour token limit set to ${tokens.toLocaleString()} (stored at ${configPath(home)}).`,
  );
}

function setUrl(args: string[]): void {
  const home = runnerHome();
  try {
    const url = setPublicUrl(args[0] ?? '', home);
    console.log(`Public URL set to ${url} (stored at ${configPath(home)}).`);
    console.log(`Ayvee should register at: ${new URL('api/register', url).toString()}`);
  } catch (err) {
    console.error(`usage: ayvee-runner set-url <url>   (${(err as Error).message})`);
    process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'mint-key':
    mintKey();
    break;
  case 'set-name':
    setName(rest);
    break;
  case 'set-limit':
    setLimit(rest);
    break;
  case 'set-url':
    setUrl(rest);
    break;
  case 'serve':
    serve(rest);
    break;
  case 'mcp':
    void mcp(rest);
    break;
  default:
    console.log(USAGE);
    process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1);
}
