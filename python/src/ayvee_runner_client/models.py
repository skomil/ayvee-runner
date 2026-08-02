"""Typed views over the runner API's JSON payloads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Health:
    status: str
    name: str
    version: str
    uptime_seconds: int
    sessions_total: int
    sessions_running: int

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Health:
        return cls(
            status=data["status"],
            name=data["name"],
            version=data["version"],
            uptime_seconds=data["uptimeSeconds"],
            sessions_total=data["sessions"]["total"],
            sessions_running=data["sessions"]["running"],
        )


@dataclass(frozen=True)
class RunnerDescriptor:
    """Identity and capabilities a runner advertises for registration."""

    runner_id: str
    name: str
    version: str
    register_url: str
    capabilities: dict[str, Any]

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> RunnerDescriptor:
        return cls(
            runner_id=data["runnerId"],
            name=data["name"],
            version=data["version"],
            register_url=data["registerUrl"],
            capabilities=data["capabilities"],
        )


@dataclass(frozen=True)
class Registration:
    """An Ayvee server registered with this runner."""

    id: str
    ayvee_url: str
    label: str | None
    registered_at: str

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Registration:
        return cls(
            id=data["id"],
            ayvee_url=data["ayveeUrl"],
            label=data["label"],
            registered_at=data["registeredAt"],
        )


@dataclass(frozen=True)
class LaunchProfile:
    id: str
    label: str
    kind: str
    cwd: str
    command: str

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> LaunchProfile:
        return cls(
            id=data["id"],
            label=data["label"],
            kind=data["kind"],
            cwd=data["cwd"],
            command=data["command"],
        )


@dataclass(frozen=True)
class Session:
    id: str
    profile_id: str
    kind: str
    name: str
    created_at: str
    status: str
    tmux_name: str | None = None
    remote_control: bool = False
    model: str | None = None
    exit_code: int | None = None

    @property
    def is_running(self) -> bool:
        return self.status == "running"

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Session:
        return cls(
            id=data["id"],
            profile_id=data["profileId"],
            kind=data["kind"],
            name=data["name"],
            created_at=data["createdAt"],
            status=data["status"],
            tmux_name=data.get("tmuxName"),
            remote_control=data.get("remoteControl", False),
            model=data.get("model"),
            exit_code=data.get("exitCode"),
        )


@dataclass(frozen=True)
class TokenBreakdown:
    """Token counts broken down by class."""

    input: int
    output: int
    cache_creation: int
    cache_read: int
    total: int

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> TokenBreakdown:
        return cls(
            input=data["input"],
            output=data["output"],
            cache_creation=data["cacheCreation"],
            cache_read=data["cacheRead"],
            total=data["total"],
        )


@dataclass(frozen=True)
class ClaudeMetrics:
    """Claude token usage within the rolling limit window plus lifetime totals."""

    window_hours: int
    window: TokenBreakdown
    lifetime: TokenBreakdown
    limit_tokens: int | None
    used_percent: float | None
    remaining_tokens: int | None
    remaining_percent: float | None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ClaudeMetrics:
        limit = data["limit"]
        return cls(
            window_hours=data["windowHours"],
            window=TokenBreakdown.from_json(data["window"]),
            lifetime=TokenBreakdown.from_json(data["lifetime"]),
            limit_tokens=limit["tokens"],
            used_percent=limit["usedPercent"],
            remaining_tokens=limit["remainingTokens"],
            remaining_percent=limit["remainingPercent"],
        )


@dataclass(frozen=True)
class ClaudeLimit:
    """One limit window exactly as the Claude CLI's /usage reports it."""

    label: str
    scope: str
    model: str | None
    used_percent: float
    remaining_percent: float
    resets_at: str

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ClaudeLimit:
        return cls(
            label=data["label"],
            scope=data["scope"],
            model=data["model"],
            used_percent=data["usedPercent"],
            remaining_percent=data["remainingPercent"],
            resets_at=data["resetsAt"],
        )


@dataclass(frozen=True)
class UsageEntry:
    """One entry of a "Top <category>" list, e.g. a skill or MCP server."""

    name: str
    percent: float

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> UsageEntry:
        return cls(name=data["name"], percent=data["percent"])


@dataclass(frozen=True)
class UsageBreakdown:
    """A "Top skills / subagents / plugins / MCP servers" list."""

    category: str
    entries: list[UsageEntry]

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> UsageBreakdown:
        return cls(
            category=data["category"],
            entries=[UsageEntry.from_json(e) for e in data["entries"]],
        )


@dataclass(frozen=True)
class UsageBehavior:
    """A percentage characteristic, e.g. 75% of usage at >150k context."""

    percent: float
    description: str

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> UsageBehavior:
        return cls(percent=data["percent"], description=data["description"])


@dataclass(frozen=True)
class UsagePeriod:
    """One "what's contributing to your limits usage" window (24h, 7d)."""

    label: str
    requests: int | None
    sessions: int | None
    behaviors: list[UsageBehavior]
    breakdowns: list[UsageBreakdown]

    def breakdown(self, category: str) -> UsageBreakdown | None:
        """The named breakdown (e.g. "MCP servers"), if present."""
        return next((b for b in self.breakdowns if b.category == category), None)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> UsagePeriod:
        return cls(
            label=data["label"],
            requests=data["requests"],
            sessions=data["sessions"],
            behaviors=[UsageBehavior.from_json(b) for b in data["behaviors"]],
            breakdowns=[UsageBreakdown.from_json(b) for b in data["breakdowns"]],
        )


@dataclass(frozen=True)
class ClaudeLimits:
    """Everything the Claude CLI's /usage reports on the runner machine."""

    source: str
    fetched_at: str
    summary: str | None
    note: str
    limits: list[ClaudeLimit]
    periods: list[UsagePeriod]
    raw: str

    @property
    def session(self) -> ClaudeLimit | None:
        """The 5-hour session window, if reported."""
        return next((limit for limit in self.limits if limit.scope == "session"), None)

    def period(self, label: str) -> UsagePeriod | None:
        """The named contributing-usage period, e.g. "Last 24h"."""
        return next((p for p in self.periods if p.label == label), None)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ClaudeLimits:
        return cls(
            source=data["source"],
            fetched_at=data["fetchedAt"],
            summary=data.get("summary"),
            note=data["note"],
            limits=[ClaudeLimit.from_json(limit) for limit in data["limits"]],
            periods=[UsagePeriod.from_json(p) for p in data.get("periods", [])],
            raw=data.get("raw", ""),
        )


@dataclass(frozen=True)
class SessionEvent:
    seq: int
    ts: str
    data: Any

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SessionEvent:
        return cls(seq=data["seq"], ts=data["ts"], data=data["data"])
