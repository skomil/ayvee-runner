"""E2E fixtures: a real ayvee-runner server driven entirely through the library.

The server is the built Node CLI (`dist/cli.js`), with a throwaway runner home:
the API key comes from actually running `ayvee-runner mint-key`, and the
profile allowlist covers real tmux sessions plus hermetic headless commands
(`cat`, a fake stream-json Claude, and an immediately-exiting shell).
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest

from ayvee_runner_client import RunnerClient

SERVER_DIR = Path(__file__).resolve().parents[3] / "server"
CLI = SERVER_DIR / "dist" / "cli.js"
FAKE_CLAUDE = Path(__file__).resolve().parent / "fake_claude.py"

def mint_key(home: Path) -> str:
    out = subprocess.run(
        ["node", str(CLI), "mint-key"],
        env={"AYVEE_RUNNER_HOME": str(home), "PATH": os.environ["PATH"]},
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    match = re.search(r"(ayr_[A-Za-z0-9_-]+)", out)
    assert match, f"mint-key printed no key:\n{out}"
    return match.group(1)


@dataclass
class Runner:
    url: str
    key: str
    home: Path
    process: subprocess.Popen

    def client(self, key: str | None = None) -> RunnerClient:
        return RunnerClient(self.url, api_key=key or self.key, timeout=10.0)


@contextmanager
def start_runner(
    home: Path, workdir: Path, extra_env: dict[str, str] | None = None
) -> Iterator[Runner]:
    """Mint a key via the real CLI, write the profile allowlist, and boot the
    built server on a free localhost port; tears the server down on exit."""
    if not CLI.exists():
        subprocess.run(["npm", "run", "build"], cwd=SERVER_DIR, check=True, capture_output=True)

    home.mkdir(parents=True, exist_ok=True)
    workdir.mkdir(parents=True, exist_ok=True)
    key = mint_key(home)
    subprocess.run(
        ["node", str(CLI), "set-name", "e2e", "test", "runner"],
        env={"AYVEE_RUNNER_HOME": str(home), "PATH": os.environ["PATH"]},
        capture_output=True,
        check=True,
    )

    def profile(pid: str, label: str, kind: str, command: str) -> dict:
        return {"id": pid, "label": label, "kind": kind, "cwd": str(workdir), "command": command}

    profiles = [
        profile("dev-shell", "Dev shell", "tmux", "bash"),
        profile("echo", "Echo agent", "headless", "cat"),
        profile("fake-claude", "Fake Claude", "headless", f"{sys.executable} {FAKE_CLAUDE}"),
        profile("exit-3", "Exits at once", "headless", "exit 3"),
        profile("print-model", "Print model", "headless", 'echo "model=$ANTHROPIC_MODEL"'),
        profile(
            "claude",
            "Headless Claude",
            "headless",
            "claude -p --input-format=stream-json --output-format=stream-json --verbose",
        ),
    ]
    (home / "profiles.json").write_text(json.dumps({"profiles": profiles}))

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    # Inherit the full environment like a real deployment — sessions the
    # runner spawns (e.g. claude) need HOME, credentials, etc.
    process = subprocess.Popen(
        ["node", str(CLI), "serve", "--port", str(port)],
        env={**os.environ, "AYVEE_RUNNER_HOME": str(home), **(extra_env or {})},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    runner = Runner(url=f"http://127.0.0.1:{port}", key=key, home=home, process=process)

    try:
        with runner.client() as client:
            client.wait_healthy(timeout=15)
        yield runner
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


@pytest.fixture(scope="session")
def runner(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Runner]:
    # Real CLI limit lookups are off here so the suite stays deterministic and
    # doesn't shell out; test_claude_limits_e2e.py covers the real path.
    with start_runner(
        tmp_path_factory.mktemp("runner-home"),
        tmp_path_factory.mktemp("workdir"),
        {"AYVEE_RUNNER_CLAUDE_USAGE": "off"},
    ) as r:
        yield r


@pytest.fixture
def client(runner: Runner) -> Iterator[RunnerClient]:
    with runner.client() as c:
        yield c
