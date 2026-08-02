"""E2E against the real thing: spawn an actual headless `claude -p` session
through the runner, ask a question, and verify Claude's answer comes back over
the event stream. Skipped where the claude CLI isn't installed (e.g. CI).
"""

from __future__ import annotations

import shutil
import time

import pytest

from ayvee_runner_client import RunnerClient

pytestmark = [
    pytest.mark.skipif(shutil.which("claude") is None, reason="claude CLI not installed"),
    pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed"),
]


def test_real_claude_answers_a_question(client: RunnerClient) -> None:
    usage_before = client.metrics().lifetime.total
    session = client.spawn_session("claude", name="real claude e2e")
    assert session.is_running

    seen = 0
    observed: list[dict] = []

    def wait_for_event(predicate, timeout: float, description: str) -> dict:
        """Scan the event stream incrementally until one matches."""
        nonlocal seen
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in client.events(session.id, since=seen):
                seen = event.seq
                data = event.data if isinstance(event.data, dict) else {}
                observed.append(data)
                if predicate(data):
                    return data
            time.sleep(0.5)
        raise AssertionError(f"no {description} within {timeout}s; saw: {observed}")

    try:
        # In stream-json input mode Claude emits its system/init event when the
        # first turn starts, so send the question straight away.
        client.send_input(
            session.id, "Reply with exactly the single word PONG and nothing else."
        )

        wait_for_event(
            lambda d: d.get("type") == "system" and d.get("subtype") == "init",
            timeout=120,
            description="system/init event",
        )

        # Wait for the turn's result event; a real completion can take a while.
        result = wait_for_event(
            lambda d: d.get("type") == "result", timeout=240, description="result event"
        )
        assistant_texts = [
            block.get("text", "")
            for data in observed
            if data.get("type") == "assistant"
            for block in data.get("message", {}).get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        assert result.get("subtype") == "success", result
        answers = [result.get("result", ""), *assistant_texts]
        assert any("PONG" in a for a in answers), f"unexpected answer: {answers}"

        # The real turn's token usage was metered.
        assert client.metrics().lifetime.total > usage_before
    finally:
        client.kill_session(session.id)
