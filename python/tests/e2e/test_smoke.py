"""The CI smoke test: one test that boots the real server on localhost and,
through the Python library, exercises every major PRD function — health
monitoring, API-key auth and rotation, the launch-profile allowlist, the tmux
session lifecycle, headless input/event dispatch, Claude usage metrics, and
the MCP surface.

Run on its own with: pytest tests/e2e/test_smoke.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ayvee_runner_client import RunnerAPIError, RunnerAuthError, SessionNotFoundError

from .conftest import CLI, mint_key, start_runner
from .mcp_stdio import McpStdioClient

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


def test_prd_smoke(tmp_path: Path) -> None:
    extra_env = {"AYVEE_RUNNER_5H_TOKEN_LIMIT": "18000"}
    with start_runner(tmp_path / "home", tmp_path / "workdir", extra_env) as runner:
        # -- Health monitoring: the runner comes up and reports ok.
        client = runner.client()
        health = client.wait_healthy(timeout=15)
        assert health.status == "ok"
        # The machine name set via `ayvee-runner set-name` identifies this server.
        assert health.name == "e2e test runner"
        assert health.sessions_total == 0

        # -- Auth: managing needs the minted key; a wrong key is rejected,
        #    while the read-only status view stays anonymously readable.
        with runner.client(key="ayr_wrong") as intruder:
            with pytest.raises(RunnerAuthError):
                intruder.list_sessions()
            assert intruder.is_healthy()
            assert intruder.metrics().window_hours == 5

        # -- Registration: the advert is public, registering needs the key.
        advert = client.registration()
        assert advert.register_url == f"{runner.url}/api/register"
        assert advert.runner_id
        registration = client.register("https://ayvee.example.com", label="smoke")
        assert [r.id for r in client.list_registrations()] == [registration.id]
        client.unregister(registration.id)

        # -- Profile allowlist: only profiles.json entries exist and spawn.
        profile_ids = {p.id for p in client.list_profiles()}
        assert {"dev-shell", "echo", "fake-claude"} <= profile_ids
        with pytest.raises(RunnerAPIError, match="unknown profile"):
            client.spawn_session("not-allowlisted")

        # -- tmux lifecycle: spawn a real tmux session, see it live, kill it.
        shell = client.spawn_session("dev-shell", name="smoke shell")
        assert shell.kind == "tmux" and shell.is_running and shell.tmux_name
        assert subprocess.run(["tmux", "has-session", "-t", f"={shell.tmux_name}"]).returncode == 0
        assert client.health().sessions_running == 1

        # -- Headless lifecycle: spawn the fake stream-json Claude, dispatch a
        #    turn, and read the assistant's reply back as events.
        agent = client.spawn_session("fake-claude")
        init = client.wait_for_events(agent.id)
        assert init[0].data["type"] == "system"
        client.send_input(agent.id, "smoke turn")
        replies = client.wait_for_events(agent.id, since=init[-1].seq, min_count=2)
        assert replies[-1].data["result"] == "echo: smoke turn"

        # -- Metrics: that turn's usage is metered against the 5h limit with
        #    the per-class breakdown (fake_claude reports 12/34/56/78 = 180).
        metrics = client.metrics()
        assert metrics.window_hours == 5
        assert metrics.window.input == 12
        assert metrics.window.output == 34
        assert metrics.window.cache_creation == 56
        assert metrics.window.cache_read == 78
        assert metrics.window.total == 180
        assert metrics.limit_tokens == 18000
        assert metrics.used_percent == 1.0
        # …and how much of the 5-hour limit is left.
        assert metrics.remaining_tokens == 17820
        assert metrics.remaining_percent == 99.0

        # -- MCP: the same operations work through the MCP server; kill the
        #    tmux session over MCP and the change is visible everywhere.
        mcp = McpStdioClient(
            ["node", str(CLI), "mcp", "--url", runner.url],
            env={"AYVEE_RUNNER_HOME": str(runner.home), "PATH": os.environ["PATH"]},
        )
        try:
            assert "create_session" in mcp.list_tool_names()
            assert mcp.call_tool("metrics")["claude"]["window"]["total"] == 180
            killed = mcp.call_tool("kill_session", {"sessionId": shell.id})["session"]
            assert killed["status"] == "exited"
        finally:
            mcp.close()
        assert subprocess.run(["tmux", "has-session", "-t", f"={shell.tmux_name}"]).returncode != 0

        # -- Kill: the remaining session dies and disappears from the registry.
        assert client.kill_session(agent.id).status == "exited"
        for session in (shell, agent):
            with pytest.raises(SessionNotFoundError):
                client.get_session(session.id)
        assert client.health().sessions_total == 0

        # -- Key rotation: re-minting on disk invalidates the old key at once.
        new_key = mint_key(runner.home)
        with pytest.raises(RunnerAuthError):
            client.list_sessions()
        with runner.client(key=new_key) as rotated:
            assert rotated.list_sessions() == []
        client.close()
