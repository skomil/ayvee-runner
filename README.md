# ayvee-runner

Per-user runner service for [Ayvee](https://www.ayvee.ai) remote sessions. It runs on **your
own machine** and spawns, lists, and kills two kinds of sessions from a local allowlist of
launch profiles:

- **tmux** sessions — e.g. a shell running `claude --remote-control`, reattachable with
  `tmux attach`.
- **headless** sessions — persistent processes such as
  `claude -p --input-format=stream-json`, kept alive so turns can be dispatched and their
  stream-json output read back as events.

The repo has two packages:

| Path | What | Toolchain |
|---|---|---|
| `server/` | The runner: HTTP API, web dashboard, `ayvee-runner` CLI | TypeScript, Express, vitest, eslint |
| `python/` | `ayvee-runner-client`, the PyPI client library + the E2E suite | Python ≥3.10, httpx, pytest, ruff |

## Setup

```sh
cd server
npm install
npm run build        # compiles the server and bundles the dashboard into dist/
```

### 1. Mint the API key

```sh
node dist/cli.js mint-key
```

The key is a secret stored at `~/.ayvee-runner/api-key` (mode 0600). The command prints it
**once** — copy it into the Ayvee server. Re-running the command rotates the key: the old key
stops working immediately (no restart needed), and it's up to you to paste the new one into
Ayvee.

### 2. Name this machine

```sh
node dist/cli.js set-name "scott's vm"
```

The name (stored in `~/.ayvee-runner/config.json`, default: the hostname) identifies this
runner wherever you look at it — the dashboard header, `GET /api/health`, the MCP `health`
tool, and the Python client's `Health.name` — so you can tell "scott's vm" from
"scott's laptop" when several runners are registered in Ayvee.

### 3. Set a token limit (optional fallback)

The runner reads your **real** limits from the Claude CLI (see
[Claude usage](#health--metrics) below), so this step is only a fallback for machines where
that CLI isn't installed or logged in.

```sh
node dist/cli.js set-limit 2000000
```

Stored in `config.json` and read per request, so it applies without a restart. With it set,
the dashboard leads with **how much of the 5-hour window is left** (e.g. "99% left") over a
usage meter, and `/api/metrics` returns `remainingTokens` / `remainingPercent`. Without it,
the runner still reports tokens used — it just can't express them as a percentage.

Anthropic doesn't publish plan limits as a token count, so pick a number that matches what
you observe and adjust it; `AYVEE_RUNNER_5H_TOKEN_LIMIT` overrides the stored value.

### 4. Declare launch profiles

The runner only ever launches commands from `~/.ayvee-runner/profiles.json` — Ayvee sends a
profile id, never a command. This allowlist is the security boundary; edit it only on the
machine itself.

```json
{
  "profiles": [
    { "id": "dev-shell", "label": "Dev shell", "kind": "tmux",
      "cwd": "/home/me/code", "command": "claude --remote-control" },
    { "id": "kb-agent", "label": "KB agent", "kind": "headless",
      "cwd": "/home/me/code", "command": "claude -p --input-format=stream-json --output-format=stream-json --verbose" }
  ]
}
```

Each profile has exactly five fields: `id` (unique), `label`, `kind` (`"tmux"` or
`"headless"`), `cwd`, and `command` (run via the shell, inside tmux or as a child process).
The file is re-read on every request, so edits apply without a restart; a malformed file is
an error (500), never a silently-empty allowlist.

### 5. Serve

```sh
node dist/cli.js serve            # http://127.0.0.1:7777
node dist/cli.js serve --port 9000
```

The dashboard is served at the same address. It opens on a **public status view** — machine
name, health, and Claude token usage render with no credential, so you can point a browser
(or a monitoring check) at it directly. Paste the API key to unlock management: launch
profiles (including a "Launch remote control" button on tmux profiles), watch active
sessions, send messages to headless sessions, and kill anything.

**Behind a reverse proxy:** every asset and API call the dashboard makes is *relative*, so
serving the runner under a path prefix works with no configuration — proxy
`https://example.com/runners/vm/` to `http://127.0.0.1:7777/` and the page, its assets, and
`api/…` all resolve under the prefix. Point the proxy at the trailing-slash form of the
prefix (as usual for relative-path apps).

## CLI reference

| Command | What it does |
|---|---|
| `ayvee-runner mint-key` | Generate + store the API key (0600), printing it once. Rotates on re-run. |
| `ayvee-runner set-name <name>` | Set this machine's display name in `config.json`. |
| `ayvee-runner set-limit <n>` | Set the 5-hour token limit used for the "% left" figure. |
| `ayvee-runner set-url <url>` | Externally reachable base URL, used when advertising the register URL. |
| `ayvee-runner serve [--port N]` | Start the runner on `127.0.0.1` (default port 7777). |
| `ayvee-runner mcp [--url U]` | Run a stdio MCP server proxying to a running runner (key read from disk). |

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AYVEE_RUNNER_HOME` | `~/.ayvee-runner` | Directory holding the on-disk state (below) |
| `AYVEE_RUNNER_PORT` | `7777` | Listen port (the `--port` flag wins) |
| `AYVEE_RUNNER_NAME` | hostname | Machine name override (beats `config.json`) |
| `AYVEE_RUNNER_5H_TOKEN_LIMIT` | unset | 5-hour token limit override (beats `config.json`) |
| `AYVEE_RUNNER_CLAUDE_USAGE` | on | Set to `off` to skip reading real limits from the Claude CLI |
| `AYVEE_RUNNER_URL` | `http://127.0.0.1:<port>` | Runner URL the `mcp` subcommand proxies to |
| `AYVEE_RUNNER_PUBLIC_URL` | derived from request | Advertised base URL override (beats `config.json`) |

### On-disk layout (`$AYVEE_RUNNER_HOME`)

```
~/.ayvee-runner/
  api-key         # the bearer token, mode 0600 — rotate with mint-key
  config.json     # { "name": "scott's vm", "runnerId": "…", "tokenLimit": 2000000, "publicUrl": "…" }
  profiles.json   # the launch-profile allowlist
  registrations.json  # Ayvee servers registered with this runner
```

The server binds to `127.0.0.1` only; the outbound channel to Ayvee (machine registry,
PAT auth) is a later build step per `context/remote-sessions.md` in the Ayvee repo.

## API reference

All routes return JSON and are `Cache-Control: no-store`. Everything requires
`Authorization: Bearer <api-key>` **except the two read-only status routes**, which are
anonymous so browsers and proxy health checks can read them; they expose no session detail,
paths, or commands.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | anonymous | Status, machine name, version, uptime, session counts |
| `GET /api/metrics` | anonymous | Claude token usage (5-hour window + lifetime, by token class) |
| `GET /api/profiles` | key | The launch-profile allowlist |
| `GET /api/sessions` | key | List sessions (liveness refreshed on read) |
| `POST /api/sessions` | key | Spawn a session from a profile |
| `GET /api/sessions/:id` | key | One session |
| `DELETE /api/sessions/:id` | key | Kill a session (tmux `kill-session` / SIGTERM) |
| `POST /api/sessions/:id/input` | key | Dispatch a user turn to a headless session |
| `GET /api/sessions/:id/events?since=N` | key | Headless output events after seq `N` |

### Errors

| Status | Meaning |
|---|---|
| `400` | Bad body (missing `profileId`, unknown profile id, non-headless input/events, `remoteControl` on a headless profile, bad `since`) |
| `401` | Missing or wrong API key |
| `404` | No session with that id |
| `500` | Server-side failure (e.g. malformed `profiles.json`) |
| `503` | No API key minted yet |

Every error body is `{ "error": "<message>" }`.

### Sessions

`POST /api/sessions` takes:

```json
{ "profileId": "dev-shell", "name": "work on ayvee", "remoteControl": true, "model": "sonnet" }
```

- `name` (optional) — display name; defaults to the profile label. Stored verbatim, never
  passed to a shell.
- `remoteControl` (optional, tmux profiles only) — instead of the profile command, the runner
  launches `claude --remote-control '<name>'` in the profile's `cwd`, so the session appears
  as a Remote Control target on claude.ai. The command is built (and shell-quoted) by the
  runner, never taken from the caller.
- `model` (optional) — start the session on a specific Claude model (e.g. `"sonnet"`,
  `"claude-opus-5"`). Exported as `ANTHROPIC_MODEL` in the session's environment, which
  Claude reads at startup — the allowlisted command is never modified, and non-Claude
  commands ignore the variable.

A session object looks like:

```json
{
  "id": "f6d185ca-…",
  "profileId": "dev-shell",
  "kind": "tmux",
  "name": "work on ayvee",
  "createdAt": "2026-08-01T19:37:41.000Z",
  "status": "running",
  "tmuxName": "ayr-f6d185ca",
  "remoteControl": true
}
```

- `status` is `"running"` or `"exited"`, refreshed from the real mechanism on every read
  (`tmux has-session` / child-process state), so externally killed sessions show up as
  exited.
- tmux sessions carry `tmuxName` (attach with `tmux attach -t <tmuxName>`); headless
  sessions carry `exitCode` once the process ends.
- The registry is **in-memory**: sessions do not survive a runner restart, and a graceful
  shutdown (SIGINT/SIGTERM) kills every session it owns.

### Headless input & events

`POST /api/sessions/:id/input` with `{ "message": "review the tags" }` writes one
stream-json user turn to the process's stdin (`202` on accept). Each stdout line becomes an
event:

```json
{ "events": [ { "seq": 7, "ts": "2026-08-01T19:40:00.000Z", "data": { "type": "assistant", "…": "…" } } ] }
```

`data` is the parsed JSON line, or `{ "raw": "<line>" }` for non-JSON output. Events are
retained in a ring buffer of the last 1000; poll incrementally with `?since=<last seq>`.

### Health & metrics

```json
// GET /api/health
{ "status": "ok", "name": "scott's vm", "version": "0.1.0", "uptimeSeconds": 42,
  "sessions": { "total": 2, "running": 1 } }

// GET /api/metrics
{ "claude": {
    "windowHours": 5,
    "window":   { "input": 6, "output": 15, "cacheCreation": 21464, "cacheRead": 55079, "total": 76564 },
    "lifetime": { "input": 6, "output": 15, "cacheCreation": 21464, "cacheRead": 55079, "total": 76564 },
    "limit": { "tokens": 500000, "usedPercent": 15.31,
               "remainingTokens": 423436, "remainingPercent": 84.69 } },
  "limits": {
    "source": "claude-cli",
    "fetchedAt": "2026-08-02T00:14:07.516Z",
    "summary": "You are currently using your subscription to power your Claude Code usage",
    "note": "Approximate, based on local sessions on this machine — does not include …",
    "limits": [
      { "label": "session", "scope": "session", "model": null,
        "usedPercent": 26, "remainingPercent": 74, "resetsAt": "Aug 2, 4:09am (UTC)" },
      { "label": "week (all models)", "scope": "week", "model": null,
        "usedPercent": 13, "remainingPercent": 87, "resetsAt": "Aug 7, 7:59pm (UTC)" },
      { "label": "week (Fable)", "scope": "week", "model": "Fable",
        "usedPercent": 16, "remainingPercent": 84, "resetsAt": "Aug 7, 8pm (UTC)" }
    ],
    "periods": [
      { "label": "Last 24h", "requests": 324, "sessions": 25,
        "behaviors": [ { "percent": 76, "description": "was at >150k context" } ],
        "breakdowns": [
          { "category": "skills", "entries": [ { "name": "/update-config", "percent": 1 } ] },
          { "category": "plugins", "entries": [ { "name": "herbert", "percent": 1 } ] },
          { "category": "MCP servers",
            "entries": [ { "name": "plugin:herbert:herbert", "percent": 62 } ] }
        ] },
      { "label": "Last 7d", "requests": 434, "sessions": 29, "behaviors": [ … ],
        "breakdowns": [ … "subagents" … ] }
    ],
    "raw": "You are currently using your subscription…" } }
```

**`limits` is the real thing.** The runner shells out to `claude -p "/usage"` — the same
local, zero-token command behind the CLI's `/usage` — and parses **everything it reports**,
so "how much is left" comes from Claude rather than from a limit you guessed:

- `limits` — each window (5-hour session, weekly all-models, weekly per-model) with percent
  used, percent left, and the reset time as the CLI prints it.
- `periods` — the "what's contributing to your limits usage" windows: request and session
  counts, behaviour percentages (`>150k context`, `subagent-heavy sessions`), and the
  Top-N breakdowns for skills, subagents, plugins, and MCP servers.
- `summary`, `note` — the CLI's own opening line and caveat.
- `raw` — the full report text, so nothing the CLI prints is lost even if it adds a section
  the parser doesn't know yet.

Readings are cached for a minute, concurrent refreshes are coalesced into one call, and the
last good reading is kept if a later lookup fails; if the CLI is missing or logged out,
`limits` is `null` and the dashboard falls back to the configured token limit. Disable the
lookup with `AYVEE_RUNNER_CLAUDE_USAGE=off`. From Python: `client.limits()`, with
`limits.session`, `limits.period("Last 24h")`, and `period.breakdown("MCP servers")`.

Note the CLI's own caveat, which the runner passes through verbatim: the figures are
approximate and cover local sessions on this machine only — not other devices or claude.ai.

Usage is metered from the `usage` fields on the stream-json `assistant` events that headless
Claude sessions emit (`result` events are skipped to avoid double-counting). `window` covers
the rolling 5-hour limit window; `lifetime` is since the runner started. With no limit
configured every `limit` field is `null`; `remainingTokens`/`remainingPercent` are clamped
at zero once the window's usage exceeds the limit. The dashboard's "Claude usage" section
leads with the percent left from `limits` (falling back to the configured token limit),
renders each window CLI-style with a meter, and keeps the metered token table below.

## Registering with Ayvee

The runner advertises how to register itself, so an Ayvee server can be pointed at a machine
without hand-editing anything.

**The advertised URL.** `GET /api/registration` is anonymous and returns the runner's
identity and what it can do:

```json
{
  "runnerId": "0b0f…",            // stable across restarts and renames
  "name": "scott's vm",
  "version": "0.1.0",
  "registerUrl": "https://scott.example.com/runners/vm/api/register",
  "capabilities": { "sessionKinds": ["tmux", "headless"], "remoteControl": true,
                    "modelSelection": true, "headlessInput": true, "metrics": true, "mcp": true }
}
```

The same URL is shown as a copyable field on the dashboard (with the runner id), and printed
on `serve` startup. It is derived from the incoming request — honouring `X-Forwarded-Proto`
and `X-Forwarded-Prefix` — or from a configured public URL, which is what you want when the
runner sits behind a proxy:

```sh
node dist/cli.js set-url "https://scott.example.com/runners/vm/"
```

**Registering.** Ayvee calls the advertised URL with the API key:

```sh
curl -X POST https://scott.example.com/runners/vm/api/register \
  -H "Authorization: Bearer $AYVEE_RUNNER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"ayveeUrl": "https://ayvee.ai", "label": "prod"}'
```

The response echoes the runner descriptor above plus the stored registration. Registering the
same `ayveeUrl` again refreshes that entry instead of duplicating it, so retries are safe.
Registrations persist in `registrations.json` and survive restarts.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/registration` | anonymous | The advert: identity, capabilities, register URL |
| `POST /api/register` | key | Register an Ayvee server `{ayveeUrl, label?}` |
| `GET /api/registrations` | key | List registered Ayvee servers |
| `DELETE /api/registrations/:id` | key | Remove a registration |

From Python: `client.registration()`, `client.register(url, label=…)`,
`client.list_registrations()`, `client.unregister(id)`.

> The outbound half — the runner dialling Ayvee and holding the connection through NAT — is
> a later build step per `context/remote-sessions.md`. This step covers discovery and the
> registration record.

## MCP

The runner is also callable over MCP. `ayvee-runner mcp` runs a stdio MCP server that
proxies every tool call to the local HTTP API (key read from `AYVEE_RUNNER_HOME`), so MCP
callers, the dashboard, and the API always see the same state. Register it with e.g.:

```sh
claude mcp add ayvee-runner -- node /path/to/server/dist/cli.js mcp
```

| Tool | Arguments |
|---|---|
| `health` | — |
| `metrics` | — |
| `list_profiles` | — |
| `list_sessions` | — |
| `create_session` | `profileId`, `name?`, `remoteControl?`, `model?` |
| `get_session` | `sessionId` |
| `kill_session` | `sessionId` |
| `send_input` | `sessionId`, `message` |
| `get_events` | `sessionId`, `since?` |

Tool results are the API's JSON; API errors surface as MCP tool errors.

## Python client

```sh
pip install ayvee-runner-client
```

```python
from ayvee_runner_client import RunnerClient

with RunnerClient("http://127.0.0.1:7777", api_key="ayr_…") as client:
    client.wait_healthy()                      # or health() / is_healthy()
    client.metrics()                           # ClaudeMetrics with TokenBreakdowns
    client.list_profiles()
    s = client.spawn_session("kb-agent", name="librarian", model="sonnet")
    client.send_input(s.id, "review the tags")
    for e in client.wait_for_events(s.id):     # or events(s.id, since=N)
        print(e.data)
    client.spawn_session("dev-shell", remote_control=True)   # claude.ai Remote Control
    client.kill_session(s.id)
```

Errors are typed: `RunnerAuthError` (401/503), `SessionNotFoundError` (404),
`RunnerAPIError` (other HTTP errors, with `.status_code`/`.message`), and
`RunnerConnectionError` (unreachable) — all subclasses of `RunnerError`. See
`python/README.md` for more.

## Security

`SECURITY.md` documents the threat model and audit. The short version: the on-disk API key
is the sole credential and every surface (API, dashboard data, MCP) refuses anything
without it; remote callers can only ever launch allowlisted profile commands. The security
integration suite (`python/tests/e2e/test_security_e2e.py`) enforces this in CI.

## Tests & lint

CI (`.github/workflows/ci.yml`) runs all of the below on every push/PR, plus
`python/tests/e2e/test_smoke.py` — a single test that boots the built server on localhost
and, through the Python library, verifies every major function: health and the machine
name, key auth and rotation, the profile allowlist, the tmux lifecycle, headless
input/events, usage metrics, and the MCP surface.

```sh
# server
cd server
npm run lint && npm run typecheck && npm test

# python (unit + E2E; E2E builds/uses server/dist, real tmux, and a fake
# stream-json claude — hermetic, no real Claude needed. One extra test spawns
# a real `claude -p` session end-to-end and is skipped when claude is absent.)
cd python
uv sync
uv run ruff check .
uv run pytest
```

## Publishing the client to PyPI

```sh
cd python
uv build
uv publish       # needs a PyPI token
```
