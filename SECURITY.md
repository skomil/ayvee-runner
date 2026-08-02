# Security audit — ayvee-runner

Last audited: 2026-08-01 (covers the API, dashboard, CLI, and MCP surfaces).

## Threat model

The runner executes commands on a personal machine, so the two assets are the
**API key** (sole credential, stored on disk at `$AYVEE_RUNNER_HOME/api-key`)
and the **launch-profile allowlist** (`profiles.json`, the blast-radius
boundary: remote callers may only pick a profile id, never a command). The
attacker of interest is anyone who can reach the HTTP port **without having
copied the key from disk** — they must be refused everything, must cause no
side effect (especially not a tmux session), and must learn nothing.

Anyone who can *read the runner home on disk* already holds the key and the
machine; that is outside the model by design (the task's premise is the user's
own hardware and credentials).

## Enforced properties (each backed by tests)

**Authentication**
- Every management route requires `Authorization: Bearer <key>` — profiles,
  sessions, spawn, kill, input, and events.
  (`test_security_e2e.py::TestEveryEndpointRefusesABadToken`, TS `auth.test.ts`)
- **Three routes are deliberately anonymous**: `GET /api/health`,
  `GET /api/metrics`, and `GET /api/registration`, so a browser or proxy can
  render a read-only status view and an Ayvee server can discover where to
  register. They expose only status, machine name, version, uptime, session
  *counts*, aggregate token usage, the runner id, capability flags, and the
  register URL — no session ids, names, profiles, commands, or paths.
  **Registering itself requires the key** (`POST /api/register`), so an
  anonymous caller can learn where to register but cannot register anything.
  A test pins the exemption to exactly these three routes and asserts no
  `cwd`/`command`/`profileId`/`tmuxName` appears in them
  (`TestEveryEndpointRefusesABadToken::test_only_status_and_the_advert_are_anonymous`).
  If you consider uptime or token counts sensitive on your network, keep the
  port loopback-only (the default) or require auth at your reverse proxy.
- Missing, malformed (`Basic`, bare `Bearer`, empty token, wrong header), and
  near-miss keys (prefix, suffix, case-changed) are all 401.
- Key comparison is constant-time (`timingSafeEqual` over SHA-256 digests, so
  length is not observable either).
- No key on disk → the server refuses everything with 503 rather than running
  open.
- Rotation via `ayvee-runner mint-key` takes effect immediately (the key is
  re-read per request); a stale key fails on the next call.
- Key file is written `0600` inside a `0700` home directory.

**No side effects without the key**
- A refused spawn creates no tmux session and no registry entry; a refused
  kill leaves the session running.
  (`TestNoSideEffectsWithoutTheToken`)

**No command execution from caller input (even with the key)**
- Extra `command`/`cwd`/`kind` fields in a spawn body are ignored — only the
  allowlisted profile's command runs. (`TestNoCommandInjection`)
- The session `name` is stored verbatim and never passed to a shell; tmux
  session names are server-generated (`ayr-<uuid8>`), and all tmux calls use
  `execFile` argument arrays with exact-match (`=name`) targets — no shell
  interpolation anywhere on the caller-controlled path.
- Profile ids are matched by equality against the allowlist; an unknown id
  (including `$(...)` payloads) is rejected before any process code runs.
- Headless input is serialized into a JSON line on the child's stdin, not a
  shell.

**No leaks**
- No response, error, or header contains the key; auth failures return a fixed
  message. The unauthenticated static dashboard assets contain no secrets (the
  dashboard only holds the key after the user pastes it, in that browser's
  localStorage). The dashboard sends no `Authorization` header at all until a
  key is entered, so the anonymous status view never transmits a credential.
- `X-Powered-By` is disabled; API responses are `Cache-Control: no-store`.
- The dashboard renders all server data via `textContent`/`createElement`
  (never `innerHTML`), so hostile session names cannot XSS the page that holds
  the key.

**Network exposure**
- The server binds `127.0.0.1` only; connections to non-loopback interfaces
  are refused. (`TestLoopbackOnly`)
- Browser cross-origin abuse (CSRF/DNS-rebinding against localhost) is
  mitigated structurally: no CORS headers are emitted, and every request needs
  the `Authorization` header, which a cross-origin page cannot attach without
  a CORS preflight the server never grants.

**MCP**
- The MCP server is a proxy holding no privileged path of its own: it reads
  the key from disk and every tool call re-authenticates against the HTTP API,
  so a wrong on-disk key yields tool errors and no side effects.
  (`TestMcpHonoursAuth`)

## Residual risks / accepted trade-offs

- **The key is plaintext on disk.** Deliberate (spec: user's own machine);
  anyone with that file has the runner. Rotate with `mint-key` if in doubt.
- **Allowlisted commands run with the server's full user privileges.** Also
  deliberate — the machine owner decides the blast radius via `profiles.json`.
  Keep that file owner-writable only.
- **No TLS** — loopback-only transport; the planned outbound channel to Ayvee
  (later build step) is where transport security will live.
- **No auth rate limiting.** Keys are 256-bit random values; online brute
  force is not a realistic vector on loopback, so complexity wasn't added.
- **500 errors surface `err.message`** (e.g. the profiles.json path) to
  *authenticated* callers; unauthenticated callers never reach those handlers.

## Running the security suite

```sh
cd python && uv run pytest tests/e2e/test_security_e2e.py -v
```

It runs as part of the E2E job in CI on every push/PR.
