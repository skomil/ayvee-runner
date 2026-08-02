"""Security integration suite, run against the real server.

The threat model (from the remote-sessions spec): the API key on disk is the
sole credential for *managing* the runner, and the launch-profile allowlist is
the blast-radius boundary. So: every management surface must refuse a caller
without the exact on-disk token, a refused caller must not be able to cause any
side effect (especially spawning a tmux session), and no response may leak the
key or execute caller-supplied commands.

The two read-only status routes (`/api/health`, `/api/metrics`) are
deliberately anonymous so a browser or proxy can render a status view; the
tests below pin down that this exemption is exactly two routes and that they
expose no secrets.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from ayvee_runner_client import RunnerAuthError, RunnerClient

from .conftest import CLI, Runner
from .mcp_stdio import McpStdioClient

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


def tmux_session_names() -> set[str]:
    out = subprocess.run(
        ["tmux", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True
    )
    return set(out.stdout.split()) if out.returncode == 0 else set()


class TestEveryEndpointRefusesABadToken:
    """A caller who has not copied the on-disk key gets 401 from every route."""

    OPERATIONS = [
        ("register", lambda c: c.register("https://attacker.example.com")),
        ("list_registrations", lambda c: c.list_registrations()),
        ("unregister", lambda c: c.unregister("any-id")),
        ("list_profiles", lambda c: c.list_profiles()),
        ("list_sessions", lambda c: c.list_sessions()),
        ("spawn_session", lambda c: c.spawn_session("dev-shell")),
        ("get_session", lambda c: c.get_session("any-id")),
        ("kill_session", lambda c: c.kill_session("any-id")),
        ("send_input", lambda c: c.send_input("any-id", "hi")),
        ("events", lambda c: c.events("any-id")),
    ]

    @pytest.mark.parametrize(("op_name", "op"), OPERATIONS, ids=[n for n, _ in OPERATIONS])
    def test_wrong_token_refused(self, runner: Runner, op_name: str, op) -> None:
        with runner.client(key="ayr_attacker") as intruder:
            with pytest.raises(RunnerAuthError) as info:
                op(intruder)
            assert info.value.status_code == 401
            # The rejection must not leak the real key.
            assert runner.key not in str(info.value)

    @pytest.mark.parametrize(
        "headers",
        [
            {},
            {"Authorization": "Bearer"},
            {"Authorization": "Basic dXNlcjpwYXNz"},
            {"Authorization": "bearer-not-a-scheme"},
            {"X-Api-Key": "anything"},
        ],
        ids=["no-header", "bare-bearer", "basic", "junk-scheme", "wrong-header"],
    )
    def test_missing_or_malformed_auth_refused(self, runner: Runner, headers: dict) -> None:
        res = httpx.get(f"{runner.url}/api/sessions", headers=headers)
        assert res.status_code == 401
        assert runner.key not in res.text

    def test_empty_bearer_token_refused(self, runner: Runner) -> None:
        # httpx won't emit a trailing-space header value, so speak raw HTTP.
        host, port = runner.url.removeprefix("http://").split(":")
        with socket.create_connection((host, int(port)), timeout=5) as sock:
            sock.sendall(
                f"GET /api/sessions HTTP/1.1\r\nHost: {host}\r\n"
                "Authorization: Bearer \r\nConnection: close\r\n\r\n".encode()
            )
            response = b""
            while chunk := sock.recv(4096):
                response += chunk
        assert b"401" in response.split(b"\r\n", 1)[0]
        assert runner.key.encode() not in response

    def test_only_status_and_the_advert_are_anonymous(self, runner: Runner) -> None:
        """The public view is deliberate — and strictly limited to read-only
        routes that expose no secrets and no session detail."""
        for path in ["/api/health", "/api/metrics", "/api/registration"]:
            res = httpx.get(f"{runner.url}{path}")
            assert res.status_code == 200, path
            assert runner.key not in res.text
            # No command, cwd, session id, or profile detail leaks here.
            for forbidden in ["cwd", "command", "profileId", "tmuxName"]:
                assert forbidden not in res.text, f"{path} leaked {forbidden}"
        for path in ["/api/profiles", "/api/sessions", "/api/registrations"]:
            assert httpx.get(f"{runner.url}{path}").status_code == 401, path
        attempt = httpx.post(f"{runner.url}/api/register", json={"ayveeUrl": "https://x.dev"})
        assert attempt.status_code == 401

    def test_near_miss_keys_refused(self, runner: Runner) -> None:
        for near_miss in [runner.key[:-1], runner.key + "x", runner.key.upper()]:
            res = httpx.get(
                f"{runner.url}/api/sessions", headers={"Authorization": f"Bearer {near_miss}"}
            )
            assert res.status_code == 401, near_miss


class TestNoSideEffectsWithoutTheToken:
    """Refused calls must not spawn anything — especially not a tmux session."""

    def test_refused_spawn_creates_no_tmux_session_and_no_registry_entry(
        self, runner: Runner, client: RunnerClient
    ) -> None:
        tmux_before = tmux_session_names()
        sessions_before = {s.id for s in client.list_sessions()}

        res = httpx.post(
            f"{runner.url}/api/sessions",
            headers={"Authorization": "Bearer ayr_attacker"},
            json={"profileId": "dev-shell"},
        )
        assert res.status_code == 401
        time.sleep(0.2)  # give any (wrongly) spawned process time to appear

        assert tmux_session_names() == tmux_before
        assert {s.id for s in client.list_sessions()} == sessions_before

    def test_refused_kill_leaves_running_sessions_alone(
        self, runner: Runner, client: RunnerClient
    ) -> None:
        session = client.spawn_session("dev-shell")
        res = httpx.delete(
            f"{runner.url}/api/sessions/{session.id}",
            headers={"Authorization": "Bearer ayr_attacker"},
        )
        assert res.status_code == 401
        assert client.get_session(session.id).is_running
        assert session.tmux_name in tmux_session_names()
        client.kill_session(session.id)


class TestNoCommandInjection:
    """Even with a valid key, only allowlisted profile commands can run."""

    def test_spawn_body_cannot_override_the_allowlisted_command(
        self, runner: Runner, client: RunnerClient, tmp_path: Path
    ) -> None:
        marker = tmp_path / "pwned-by-command-override"
        res = httpx.post(
            f"{runner.url}/api/sessions",
            headers={"Authorization": f"Bearer {runner.key}"},
            json={
                "profileId": "echo",
                "command": f"touch {marker}",
                "cwd": str(tmp_path),
                "kind": "tmux",
            },
        )
        assert res.status_code == 201
        session = res.json()["session"]
        # The extra fields were ignored: it is the allowlisted headless `cat`.
        assert session["kind"] == "headless"
        assert session["profileId"] == "echo"
        time.sleep(0.3)
        assert not marker.exists()
        client.kill_session(session["id"])

    def test_session_name_with_shell_metacharacters_is_inert(
        self, runner: Runner, client: RunnerClient, tmp_path: Path
    ) -> None:
        marker = tmp_path / "pwned-by-name"
        hostile = f'"; touch {marker}; echo "'
        session = client.spawn_session("dev-shell", name=hostile)
        assert session.name == hostile  # stored verbatim, never shelled out
        time.sleep(0.3)
        assert not marker.exists()
        client.kill_session(session.id)

    def test_unknown_profile_never_reaches_a_shell(self, client: RunnerClient) -> None:
        res_ids = [p.id for p in client.list_profiles()]
        assert "$(id)" not in res_ids
        with pytest.raises(Exception, match="unknown profile"):
            client.spawn_session("$(id); touch /tmp/pwned-by-profile-id")


class TestNothingLeaks:
    def test_unauthenticated_surfaces_never_contain_the_key(self, runner: Runner) -> None:
        # The dashboard's static assets are served without auth by design —
        # they must not embed the key (it lives only on disk + in the browser
        # of a user who pasted it).
        for path in ["/", "/dashboard.js", "/style.css"]:
            res = httpx.get(f"{runner.url}{path}")
            assert res.status_code == 200
            assert runner.key not in res.text
        denied = httpx.get(f"{runner.url}/api/sessions")
        assert denied.status_code == 401
        assert runner.key not in denied.text
        assert "x-powered-by" not in denied.headers

    def test_api_responses_are_marked_no_store(self, runner: Runner, client: RunnerClient) -> None:
        res = httpx.get(
            f"{runner.url}/api/health", headers={"Authorization": f"Bearer {runner.key}"}
        )
        assert res.headers["cache-control"] == "no-store"

    def test_key_file_is_owner_only(self, runner: Runner) -> None:
        assert (runner.home / "api-key").stat().st_mode & 0o777 == 0o600


class TestLoopbackOnly:
    def test_server_is_unreachable_on_non_loopback_interfaces(self, runner: Runner) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # no traffic sent; just picks the outbound iface
            lan_ip = probe.getsockname()[0]
        if lan_ip.startswith("127."):
            pytest.skip("no non-loopback interface available")
        port = int(runner.url.rsplit(":", 1)[1])
        with pytest.raises(OSError):
            socket.create_connection((lan_ip, port), timeout=2)


class TestMcpHonoursAuth:
    def test_mcp_with_a_wrong_on_disk_key_cannot_act(
        self, runner: Runner, client: RunnerClient, tmp_path: Path
    ) -> None:
        stolen_home = tmp_path / "attacker-home"
        stolen_home.mkdir()
        (stolen_home / "api-key").write_text("ayr_attacker\n")
        mcp = McpStdioClient(
            ["node", str(CLI), "mcp", "--url", runner.url],
            env={"AYVEE_RUNNER_HOME": str(stolen_home), "PATH": os.environ["PATH"]},
        )
        try:
            before = {s.id for s in client.list_sessions()}
            with pytest.raises(RuntimeError, match="invalid or missing API key"):
                mcp.call_tool("create_session", {"profileId": "dev-shell"})
            with pytest.raises(RuntimeError, match="invalid or missing API key"):
                mcp.call_tool("list_sessions")
            assert {s.id for s in client.list_sessions()} == before
        finally:
            mcp.close()
