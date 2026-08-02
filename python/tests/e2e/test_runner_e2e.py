"""End-to-end tests: every feature exercised through the Python library
against the real built Node server, real tmux, and real headless processes.

Tests run in definition order; the key-rotation test is last because it
invalidates the session-wide key and swaps in the new one.
"""

from __future__ import annotations

import shutil
import subprocess
import time

import pytest

from ayvee_runner_client import (
    RunnerAPIError,
    RunnerAuthError,
    RunnerClient,
    Session,
    SessionNotFoundError,
)

from .conftest import Runner, mint_key

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


def tmux_has_session(name: str) -> bool:
    return (
        subprocess.run(
            ["tmux", "has-session", "-t", f"={name}"],
            capture_output=True,
        ).returncode
        == 0
    )


def wait_until_exited(client: RunnerClient, session_id: str, timeout: float = 5.0) -> Session:
    deadline = time.monotonic() + timeout
    while True:
        session = client.get_session(session_id)
        if session.status == "exited":
            return session
        assert time.monotonic() < deadline, f"session {session_id} still running after {timeout}s"
        time.sleep(0.05)


class TestHealth:
    def test_health_through_library(self, client: RunnerClient) -> None:
        health = client.wait_healthy(timeout=10)
        assert health.status == "ok"
        # Set via the real `ayvee-runner set-name` CLI in the fixture.
        assert health.name == "e2e test runner"
        assert health.version == "0.1.0"
        assert health.uptime_seconds >= 0
        assert client.is_healthy()

    def test_session_counts_track_spawn_and_kill(self, client: RunnerClient) -> None:
        before = client.health()
        session = client.spawn_session("echo")
        during = client.health()
        assert during.sessions_total == before.sessions_total + 1
        assert during.sessions_running == before.sessions_running + 1
        client.kill_session(session.id)
        after = client.health()
        assert after.sessions_total == before.sessions_total


class TestAuth:
    def test_wrong_key_is_rejected_for_management(self, runner: Runner) -> None:
        with runner.client(key="ayr_wrong") as bad:
            with pytest.raises(RunnerAuthError):
                bad.list_profiles()
            with pytest.raises(RunnerAuthError):
                bad.list_sessions()
            with pytest.raises(RunnerAuthError):
                bad.spawn_session("dev-shell")

    def test_status_is_readable_without_a_valid_key(self, runner: Runner) -> None:
        # Health and metrics are a public status view, so a browser (or a
        # proxy health check) can read them with no credential at all.
        with runner.client(key="ayr_wrong") as anonymous:
            assert anonymous.is_healthy()
            assert anonymous.health().name == "e2e test runner"
            assert anonymous.metrics().window_hours == 5


class TestProfiles:
    def test_allowlist_is_returned_verbatim(self, client: RunnerClient) -> None:
        profiles = {p.id: p for p in client.list_profiles()}
        assert set(profiles) == {
            "dev-shell",
            "echo",
            "fake-claude",
            "exit-3",
            "claude",
            "print-model",
        }
        assert profiles["dev-shell"].kind == "tmux"
        assert profiles["dev-shell"].command == "bash"
        assert profiles["echo"].kind == "headless"

    def test_unknown_profile_is_rejected(self, client: RunnerClient) -> None:
        with pytest.raises(RunnerAPIError, match="unknown profile"):
            client.spawn_session("not-in-allowlist")

    def test_remote_control_is_rejected_for_headless_profiles(self, client: RunnerClient) -> None:
        with pytest.raises(RunnerAPIError, match="tmux"):
            client.spawn_session("echo", remote_control=True)


class TestTmuxSessions:
    def test_full_lifecycle_creates_and_kills_a_real_tmux_session(
        self, client: RunnerClient
    ) -> None:
        session = client.spawn_session("dev-shell", name="e2e shell")
        assert session.kind == "tmux"
        assert session.name == "e2e shell"
        assert session.is_running
        assert session.tmux_name and tmux_has_session(session.tmux_name)

        assert session.id in [s.id for s in client.list_sessions()]
        assert client.get_session(session.id).is_running

        killed = client.kill_session(session.id)
        assert killed.status == "exited"
        assert not tmux_has_session(session.tmux_name)
        with pytest.raises(SessionNotFoundError):
            client.get_session(session.id)

    def test_externally_killed_tmux_session_reports_exited(self, client: RunnerClient) -> None:
        session = client.spawn_session("dev-shell")
        assert session.tmux_name
        subprocess.run(["tmux", "kill-session", "-t", f"={session.tmux_name}"], check=True)
        assert client.get_session(session.id).status == "exited"
        client.kill_session(session.id)

    def test_input_and_events_are_rejected_for_tmux_sessions(self, client: RunnerClient) -> None:
        session = client.spawn_session("dev-shell")
        with pytest.raises(RunnerAPIError, match="headless"):
            client.send_input(session.id, "hello")
        with pytest.raises(RunnerAPIError, match="headless"):
            client.events(session.id)
        client.kill_session(session.id)


class TestHeadlessSessions:
    def test_echo_roundtrip_with_event_pagination(self, client: RunnerClient) -> None:
        session = client.spawn_session("echo")
        assert session.kind == "headless"
        assert session.is_running

        client.send_input(session.id, "ping from the library")
        events = client.wait_for_events(session.id)
        assert events[0].data == {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "ping from the library"}],
            },
        }
        assert client.events(session.id, since=events[-1].seq) == []

        client.kill_session(session.id)
        with pytest.raises(SessionNotFoundError):
            client.get_session(session.id)

    def test_fake_claude_speaks_the_stream_json_protocol(self, client: RunnerClient) -> None:
        session = client.spawn_session("fake-claude")

        init = client.wait_for_events(session.id)
        assert init[0].data["type"] == "system"
        assert init[0].data["subtype"] == "init"

        client.send_input(session.id, "review the tags")
        events = client.wait_for_events(session.id, since=init[-1].seq, min_count=2)
        by_type = {e.data["type"]: e.data for e in events}
        assert by_type["assistant"]["message"]["content"][0]["text"] == "echo: review the tags"
        assert by_type["result"]["result"] == "echo: review the tags"

        # A second turn keeps working — the session is persistent, not one-shot.
        client.send_input(session.id, "second turn")
        more = client.wait_for_events(session.id, since=events[-1].seq, min_count=2)
        assert more[-1].data["result"] == "echo: second turn"

        client.kill_session(session.id)

    def test_model_option_reaches_the_session_environment(self, client: RunnerClient) -> None:
        session = client.spawn_session("print-model", model="claude-opus-5")
        assert session.model == "claude-opus-5"
        events = client.wait_for_events(session.id)
        assert events[0].data == {"raw": "model=claude-opus-5"}
        client.kill_session(session.id)

    def test_exited_process_reports_exit_code_and_rejects_input(
        self, client: RunnerClient
    ) -> None:
        session = client.spawn_session("exit-3")
        exited = wait_until_exited(client, session.id)
        assert exited.exit_code == 3
        with pytest.raises(RunnerAPIError, match="exited"):
            client.send_input(session.id, "too late")
        client.kill_session(session.id)


class TestMetrics:
    def test_headless_usage_is_metered_with_breakdown(self, client: RunnerClient) -> None:
        before = client.metrics()
        assert before.window_hours == 5

        session = client.spawn_session("fake-claude")
        init = client.wait_for_events(session.id)
        client.send_input(session.id, "meter this turn")
        client.wait_for_events(session.id, since=init[-1].seq, min_count=2)
        client.kill_session(session.id)

        after = client.metrics()
        # fake_claude reports usage {input: 12, output: 34, cache write: 56, cache read: 78}.
        assert after.window.input - before.window.input == 12
        assert after.window.output - before.window.output == 34
        assert after.window.cache_creation - before.window.cache_creation == 56
        assert after.window.cache_read - before.window.cache_read == 78
        assert after.window.total - before.window.total == 180
        assert after.lifetime.total - before.lifetime.total == 180
        # No limit is configured for the E2E server, so percentages are unset.
        assert after.limit_tokens is None and after.used_percent is None
        assert after.remaining_tokens is None and after.remaining_percent is None


class TestErrors:
    def test_unknown_session_raises_not_found(self, client: RunnerClient) -> None:
        with pytest.raises(SessionNotFoundError):
            client.get_session("no-such-id")
        with pytest.raises(SessionNotFoundError):
            client.kill_session("no-such-id")


class TestZKeyRotation:
    """Last: rotating the key invalidates the one used by every fixture above."""

    def test_mint_key_rotation_takes_effect_without_restart(self, runner: Runner) -> None:
        old_key = runner.key
        new_key = mint_key(runner.home)
        assert new_key != old_key

        # Checked on a managed route: health stays anonymous either way.
        with runner.client(key=old_key) as stale, pytest.raises(RunnerAuthError):
            stale.list_sessions()

        runner.key = new_key
        with runner.client() as fresh:
            assert fresh.list_sessions() == []
