"""E2E tests for the MCP surface: `ayvee-runner mcp` over real stdio,
proxying to the real server — verified for consistency against the library."""

from __future__ import annotations

import os
import shutil
from collections.abc import Iterator

import pytest

from ayvee_runner_client import RunnerClient

from .conftest import CLI, Runner
from .mcp_stdio import McpStdioClient

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


@pytest.fixture
def mcp(runner: Runner) -> Iterator[McpStdioClient]:
    client = McpStdioClient(
        ["node", str(CLI), "mcp", "--url", runner.url],
        env={"AYVEE_RUNNER_HOME": str(runner.home), "PATH": os.environ["PATH"]},
    )
    yield client
    client.close()


class TestMcp:
    def test_exposes_all_runner_operations_as_tools(self, mcp: McpStdioClient) -> None:
        assert sorted(mcp.list_tool_names()) == [
            "create_session",
            "get_events",
            "get_session",
            "health",
            "kill_session",
            "list_profiles",
            "list_sessions",
            "metrics",
            "send_input",
        ]

    def test_health_profiles_and_metrics(self, mcp: McpStdioClient) -> None:
        assert mcp.call_tool("health")["status"] == "ok"
        profile_ids = {p["id"] for p in mcp.call_tool("list_profiles")["profiles"]}
        assert "dev-shell" in profile_ids
        metrics = mcp.call_tool("metrics")["claude"]
        assert metrics["windowHours"] == 5
        assert set(metrics["window"]) == {"input", "output", "cacheCreation", "cacheRead", "total"}

    def test_session_lifecycle_via_mcp_is_visible_to_the_library(
        self, mcp: McpStdioClient, client: RunnerClient
    ) -> None:
        created = mcp.call_tool("create_session", {"profileId": "fake-claude", "name": "mcp kb"})[
            "session"
        ]
        assert created["status"] == "running"

        # The library sees the MCP-created session — one shared registry.
        assert created["id"] in [s.id for s in client.list_sessions()]

        init = client.wait_for_events(created["id"])
        mcp.call_tool("send_input", {"sessionId": created["id"], "message": "hello over mcp"})
        client.wait_for_events(created["id"], since=init[-1].seq, min_count=2)

        events = mcp.call_tool("get_events", {"sessionId": created["id"]})["events"]
        replies = [e["data"] for e in events if e["data"].get("type") == "result"]
        assert replies and replies[-1]["result"] == "echo: hello over mcp"

        killed = mcp.call_tool("kill_session", {"sessionId": created["id"]})["session"]
        assert killed["status"] == "exited"
        assert created["id"] not in [s.id for s in client.list_sessions()]

    def test_tool_errors_are_reported(self, mcp: McpStdioClient) -> None:
        with pytest.raises(RuntimeError, match="no session"):
            mcp.call_tool("get_session", {"sessionId": "does-not-exist"})
        with pytest.raises(RuntimeError, match="unknown profile"):
            mcp.call_tool("create_session", {"profileId": "not-allowlisted"})
