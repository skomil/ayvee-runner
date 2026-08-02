"""E2E against the real Claude CLI: the runner surfaces the same limit figures
`claude -p "/usage"` prints — percent used, percent left, and reset times.

Skipped where the claude CLI isn't installed or logged in (e.g. CI).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from .conftest import start_runner

pytestmark = pytest.mark.skipif(shutil.which("claude") is None, reason="claude CLI not installed")


def cli_reports_usage() -> bool:
    """True when the local CLI actually returns limit lines (i.e. logged in)."""
    out = subprocess.run(
        ["claude", "-p", "/usage", "--output-format", "json"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return "% used" in out.stdout


def test_runner_reports_the_same_limits_as_the_cli(tmp_path: Path) -> None:
    if not cli_reports_usage():
        pytest.skip("claude CLI reports no usage (not logged in to a subscription)")

    with start_runner(tmp_path / "home", tmp_path / "workdir") as runner, runner.client() as client:
        client.wait_healthy(timeout=15)
        limits = client.limits()

    assert limits is not None, "runner reported no limits despite a working CLI"
    assert limits.source == "claude-cli"
    assert "does not include other devices" in limits.note
    assert limits.limits, "no limit windows parsed"

    session = limits.session
    assert session is not None, "no 5-hour session window reported"
    assert 0 <= session.used_percent <= 100
    assert session.remaining_percent == pytest.approx(100 - session.used_percent, abs=0.01)
    assert session.resets_at  # e.g. "Aug 2, 4:09am (UTC)"

    # Weekly windows come through with their model scoping intact.
    weekly = [limit for limit in limits.limits if limit.scope == "week"]
    assert weekly, "no weekly window reported"
    assert all(0 <= limit.remaining_percent <= 100 for limit in weekly)

    # The rest of the report: plan summary, raw text, and the
    # contributing-usage periods with their counts and breakdowns.
    assert limits.summary and "usage" in limits.summary
    assert "Current session" in limits.raw
    assert limits.periods, "no contributing-usage periods reported"
    for period in limits.periods:
        assert period.label.startswith("Last ")
        assert period.requests is None or period.requests >= 0
        assert period.sessions is None or period.sessions >= 0
        assert all(0 <= b.percent <= 100 and b.description for b in period.behaviors)
        for breakdown in period.breakdowns:
            assert breakdown.category
            assert all(e.name and 0 <= e.percent <= 100 for e in breakdown.entries)
