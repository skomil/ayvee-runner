"""Unit tests for RunnerClient against a mocked HTTP transport."""

from __future__ import annotations

import json

import httpx
import pytest

from ayvee_runner_client import (
    RunnerAPIError,
    RunnerAuthError,
    RunnerClient,
    RunnerConnectionError,
    SessionNotFoundError,
)

SESSION_JSON = {
    "id": "abc",
    "profileId": "shell",
    "kind": "tmux",
    "name": "Shell",
    "createdAt": "2026-08-01T00:00:00.000Z",
    "status": "running",
    "tmuxName": "ayr-abc",
}


def make_client(handler) -> RunnerClient:
    return RunnerClient(
        "http://127.0.0.1:7777",
        api_key="ayr_test",
        transport=httpx.MockTransport(handler),
    )


def respond(data: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=data)


class TestRequestPlumbing:
    def test_sends_bearer_key_and_hits_api_paths(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers["Authorization"]
            seen["path"] = request.url.path
            return respond(
                {
                    "status": "ok",
                    "name": "scott's vm",
                    "version": "0.1.0",
                    "uptimeSeconds": 5,
                    "sessions": {"total": 0, "running": 0},
                }
            )

        with make_client(handler) as client:
            health = client.health()
        assert seen == {"auth": "Bearer ayr_test", "path": "/api/health"}
        assert health.status == "ok"
        assert health.name == "scott's vm"
        assert health.uptime_seconds == 5

    def test_connection_failure_raises_connection_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        with make_client(handler) as client, pytest.raises(RunnerConnectionError):
            client.health()

    @pytest.mark.parametrize(
        ("status", "exc"),
        [(401, RunnerAuthError), (503, RunnerAuthError), (404, SessionNotFoundError)],
    )
    def test_error_statuses_map_to_typed_errors(self, status: int, exc: type) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return respond({"error": "nope"}, status)

        with make_client(handler) as client, pytest.raises(exc) as info:
            client.list_sessions()
        assert info.value.status_code == status
        assert info.value.message == "nope"

    def test_other_errors_raise_api_error_with_body_text(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        with make_client(handler) as client, pytest.raises(RunnerAPIError) as info:
            client.list_sessions()
        assert info.value.status_code == 500
        assert info.value.message == "boom"


class TestEndpoints:
    def test_list_profiles(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/profiles"
            return respond(
                {
                    "profiles": [
                        {
                            "id": "shell",
                            "label": "Shell",
                            "kind": "tmux",
                            "cwd": "/tmp",
                            "command": "bash",
                        }
                    ]
                }
            )

        with make_client(handler) as client:
            profiles = client.list_profiles()
        assert len(profiles) == 1
        assert profiles[0].id == "shell"
        assert profiles[0].kind == "tmux"

    def test_spawn_session_posts_profile_and_name(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "POST"
            assert json.loads(request.content) == {"profileId": "shell", "name": "work"}
            return respond({"session": SESSION_JSON}, 201)

        with make_client(handler) as client:
            session = client.spawn_session("shell", name="work")
        assert session.id == "abc"
        assert session.is_running
        assert session.tmux_name == "ayr-abc"

    def test_spawn_session_omits_name_when_absent(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert json.loads(request.content) == {"profileId": "shell"}
            return respond({"session": SESSION_JSON}, 201)

        with make_client(handler) as client:
            session = client.spawn_session("shell")
        assert session.remote_control is False

    def test_spawn_session_with_model(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert json.loads(request.content) == {"profileId": "shell", "model": "sonnet"}
            return respond({"session": {**SESSION_JSON, "model": "sonnet"}}, 201)

        with make_client(handler) as client:
            session = client.spawn_session("shell", model="sonnet")
        assert session.model == "sonnet"

    def test_spawn_session_with_remote_control(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert json.loads(request.content) == {"profileId": "shell", "remoteControl": True}
            return respond({"session": {**SESSION_JSON, "remoteControl": True}}, 201)

        with make_client(handler) as client:
            session = client.spawn_session("shell", remote_control=True)
        assert session.remote_control is True

    def test_get_list_and_kill_session(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "DELETE":
                assert request.url.path == "/api/sessions/abc"
                return respond({"session": {**SESSION_JSON, "status": "exited"}})
            if request.url.path == "/api/sessions":
                return respond({"sessions": [SESSION_JSON]})
            return respond({"session": SESSION_JSON})

        with make_client(handler) as client:
            assert [s.id for s in client.list_sessions()] == ["abc"]
            assert client.get_session("abc").id == "abc"
            killed = client.kill_session("abc")
        assert killed.status == "exited"
        assert not killed.is_running

    def test_send_input_posts_message(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/sessions/abc/input"
            assert json.loads(request.content) == {"message": "hi"}
            return respond({"ok": True}, 202)

        with make_client(handler) as client:
            client.send_input("abc", "hi")

    def test_events_passes_since_param(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/sessions/abc/events"
            assert request.url.params["since"] == "7"
            return respond({"events": [{"seq": 8, "ts": "t", "data": {"raw": "x"}}]})

        with make_client(handler) as client:
            events = client.events("abc", since=7)
        assert events[0].seq == 8
        assert events[0].data == {"raw": "x"}


class TestMetrics:
    def test_metrics_parses_the_breakdown(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/metrics"
            return respond(
                {
                    "claude": {
                        "windowHours": 5,
                        "window": {
                            "input": 10,
                            "output": 5,
                            "cacheCreation": 20,
                            "cacheRead": 30,
                            "total": 65,
                        },
                        "lifetime": {
                            "input": 100,
                            "output": 50,
                            "cacheCreation": 200,
                            "cacheRead": 300,
                            "total": 650,
                        },
                        "limit": {
                            "tokens": 6500,
                            "usedPercent": 1.0,
                            "remainingTokens": 6435,
                            "remainingPercent": 99.0,
                        },
                    }
                }
            )

        with make_client(handler) as client:
            metrics = client.metrics()
        assert metrics.window_hours == 5
        assert metrics.remaining_tokens == 6435
        assert metrics.remaining_percent == 99.0
        assert metrics.window.input == 10
        assert metrics.window.cache_creation == 20
        assert metrics.window.cache_read == 30
        assert metrics.window.total == 65
        assert metrics.lifetime.total == 650
        assert metrics.limit_tokens == 6500
        assert metrics.used_percent == 1.0

    def test_limits_parses_the_cli_report(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return respond(
                {
                    "claude": {},
                    "limits": {
                        "source": "claude-cli",
                        "fetchedAt": "2026-08-02T00:00:00.000Z",
                        "summary": "You are currently using your subscription",
                        "note": "Reported by the Claude CLI",
                        "raw": "…full report…",
                        "periods": [
                            {
                                "label": "Last 24h",
                                "requests": 309,
                                "sessions": 24,
                                "behaviors": [
                                    {"percent": 75, "description": "was at >150k context"}
                                ],
                                "breakdowns": [
                                    {
                                        "category": "MCP servers",
                                        "entries": [
                                            {"name": "plugin:herbert:herbert", "percent": 61},
                                            {"name": "claude.ai ayvee", "percent": 1},
                                        ],
                                    }
                                ],
                            }
                        ],
                        "limits": [
                            {
                                "label": "session",
                                "scope": "session",
                                "model": None,
                                "usedPercent": 20,
                                "remainingPercent": 80,
                                "resetsAt": "Aug 2, 4:09am (UTC)",
                            },
                            {
                                "label": "week (Fable)",
                                "scope": "week",
                                "model": "Fable",
                                "usedPercent": 16,
                                "remainingPercent": 84,
                                "resetsAt": "Aug 7, 8pm (UTC)",
                            },
                        ],
                    },
                }
            )

        with make_client(handler) as client:
            limits = client.limits()
        assert limits is not None
        assert limits.source == "claude-cli"
        assert limits.session is not None
        assert limits.session.remaining_percent == 80
        assert limits.session.resets_at == "Aug 2, 4:09am (UTC)"
        assert limits.limits[1].model == "Fable"

        # Every contributing-usage metric comes through too.
        assert limits.summary is not None
        assert limits.raw
        day = limits.period("Last 24h")
        assert day is not None
        assert (day.requests, day.sessions) == (309, 24)
        assert day.behaviors[0].description == "was at >150k context"
        mcp = day.breakdown("MCP servers")
        assert mcp is not None
        assert [(e.name, e.percent) for e in mcp.entries] == [
            ("plugin:herbert:herbert", 61),
            ("claude.ai ayvee", 1),
        ]

    def test_limits_is_none_when_the_cli_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return respond({"claude": {}, "limits": None})

        with make_client(handler) as client:
            assert client.limits() is None

    def test_metrics_without_a_configured_limit(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            zero = {"input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0, "total": 0}
            return respond(
                {
                    "claude": {
                        "windowHours": 5,
                        "window": zero,
                        "lifetime": zero,
                        "limit": {
                            "tokens": None,
                            "usedPercent": None,
                            "remainingTokens": None,
                            "remainingPercent": None,
                        },
                    }
                }
            )

        with make_client(handler) as client:
            metrics = client.metrics()
        assert metrics.limit_tokens is None
        assert metrics.used_percent is None
        assert metrics.remaining_tokens is None
        assert metrics.remaining_percent is None


class TestRegistration:
    DESCRIPTOR = {
        "runnerId": "11111111-2222-3333-4444-555555555555",
        "name": "scott's vm",
        "version": "0.1.0",
        "registerUrl": "https://scott.example.com/runners/vm/api/register",
        "capabilities": {"sessionKinds": ["tmux", "headless"], "remoteControl": True},
    }
    REGISTRATION = {
        "id": "reg-1",
        "ayveeUrl": "https://ayvee.ai",
        "label": "prod",
        "registeredAt": "2026-08-02T00:00:00.000Z",
    }

    def test_registration_advert(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/registration"
            return respond(self.DESCRIPTOR)

        with make_client(handler) as client:
            descriptor = client.registration()
        assert descriptor.runner_id == self.DESCRIPTOR["runnerId"]
        assert descriptor.register_url.endswith("/api/register")
        assert descriptor.capabilities["remoteControl"] is True

    def test_register_posts_the_ayvee_url(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/register"
            assert json.loads(request.content) == {"ayveeUrl": "https://ayvee.ai", "label": "prod"}
            return respond({"runner": self.DESCRIPTOR, "registration": self.REGISTRATION}, 201)

        with make_client(handler) as client:
            registration = client.register("https://ayvee.ai", label="prod")
        assert registration.id == "reg-1"
        assert registration.ayvee_url == "https://ayvee.ai"
        assert registration.label == "prod"

    def test_register_omits_label_when_absent(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert json.loads(request.content) == {"ayveeUrl": "https://ayvee.ai"}
            return respond({"runner": self.DESCRIPTOR, "registration": self.REGISTRATION}, 201)

        with make_client(handler) as client:
            client.register("https://ayvee.ai")

    def test_list_and_unregister(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "DELETE":
                assert request.url.path == "/api/registrations/reg-1"
                return respond({"ok": True})
            return respond({"registrations": [self.REGISTRATION]})

        with make_client(handler) as client:
            assert [r.id for r in client.list_registrations()] == ["reg-1"]
            client.unregister("reg-1")


class TestHealthHelpers:
    def test_is_healthy_false_on_any_runner_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return respond({"error": "nope"}, 401)

        with make_client(handler) as client:
            assert client.is_healthy() is False

    def test_wait_healthy_returns_once_healthy(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] < 3:
                raise httpx.ConnectError("not up yet")
            return respond(
                {
                    "status": "ok",
                    "name": "scott's vm",
                    "version": "0.1.0",
                    "uptimeSeconds": 1,
                    "sessions": {"total": 0, "running": 0},
                }
            )

        with make_client(handler) as client:
            health = client.wait_healthy(timeout=5, interval=0.01)
        assert health.status == "ok"
        assert calls["n"] == 3

    def test_wait_healthy_gives_up_after_timeout(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("never up")

        with make_client(handler) as client, pytest.raises(
            RunnerConnectionError, match="not healthy"
        ):
            client.wait_healthy(timeout=0.05, interval=0.01)

    def test_wait_healthy_fails_fast_on_bad_key(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return respond({"error": "invalid or missing API key"}, 401)

        with make_client(handler) as client, pytest.raises(RunnerAuthError):
            client.wait_healthy(timeout=5, interval=0.01)

    def test_wait_for_events_times_out(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return respond({"events": []})

        with make_client(handler) as client, pytest.raises(TimeoutError):
            client.wait_for_events("abc", timeout=0.05, interval=0.01)
