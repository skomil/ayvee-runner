"""HTTP client for the ayvee-runner API."""

from __future__ import annotations

import time
from types import TracebackType
from typing import Any

import httpx

from .errors import (
    RunnerAPIError,
    RunnerAuthError,
    RunnerConnectionError,
    RunnerError,
    SessionNotFoundError,
)
from .models import (
    ClaudeLimits,
    ClaudeMetrics,
    Health,
    LaunchProfile,
    Registration,
    RunnerDescriptor,
    Session,
    SessionEvent,
)


class RunnerClient:
    """Synchronous client for a single ayvee-runner instance.

    The runner listens on the machine's loopback interface; every request is
    authenticated with the API key minted by ``ayvee-runner mint-key``.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> RunnerClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            res = self._http.request(method, path, **kwargs)
        except httpx.TransportError as err:
            raise RunnerConnectionError(str(err)) from err
        if res.is_success:
            return res.json()
        try:
            message = res.json().get("error", res.text)
        except ValueError:
            message = res.text
        if res.status_code in (401, 503):
            raise RunnerAuthError(res.status_code, message)
        if res.status_code == 404:
            raise SessionNotFoundError(res.status_code, message)
        raise RunnerAPIError(res.status_code, message)

    # -- health -------------------------------------------------------------

    def health(self) -> Health:
        """Fetch the runner's health snapshot."""
        return Health.from_json(self._request("GET", "/api/health"))

    def is_healthy(self) -> bool:
        """True if the runner is reachable, authenticated, and reporting ok."""
        try:
            return self.health().status == "ok"
        except RunnerError:
            return False

    def wait_healthy(self, *, timeout: float = 30.0, interval: float = 0.25) -> Health:
        """Poll until the runner reports healthy; raise if it never does."""
        deadline = time.monotonic() + timeout
        last_error: RunnerError | None = None
        while time.monotonic() < deadline:
            try:
                health = self.health()
                if health.status == "ok":
                    return health
            except RunnerAuthError:
                raise  # a bad key never becomes healthy by waiting
            except RunnerError as err:
                last_error = err
            time.sleep(interval)
        raise RunnerConnectionError(
            f"runner not healthy after {timeout}s"
            + (f" (last error: {last_error})" if last_error else "")
        )

    def metrics(self) -> ClaudeMetrics:
        """Claude token usage: 5-hour-window and lifetime totals by token class."""
        return ClaudeMetrics.from_json(self._request("GET", "/api/metrics")["claude"])

    def limits(self) -> ClaudeLimits | None:
        """Real plan limits as the Claude CLI reports them (percent used/left
        and reset times), or None when the CLI can't be consulted."""
        data = self._request("GET", "/api/metrics").get("limits")
        return None if data is None else ClaudeLimits.from_json(data)

    # -- registration -------------------------------------------------------

    def registration(self) -> RunnerDescriptor:
        """The runner's advertised identity, capabilities, and register URL.

        Anonymous: readable without an API key.
        """
        return RunnerDescriptor.from_json(self._request("GET", "/api/registration"))

    def register(self, ayvee_url: str, *, label: str | None = None) -> Registration:
        """Register an Ayvee server with this runner."""
        body: dict[str, Any] = {"ayveeUrl": ayvee_url}
        if label is not None:
            body["label"] = label
        return Registration.from_json(
            self._request("POST", "/api/register", json=body)["registration"]
        )

    def list_registrations(self) -> list[Registration]:
        data = self._request("GET", "/api/registrations")
        return [Registration.from_json(r) for r in data["registrations"]]

    def unregister(self, registration_id: str) -> None:
        self._request("DELETE", f"/api/registrations/{registration_id}")

    # -- profiles -----------------------------------------------------------

    def list_profiles(self) -> list[LaunchProfile]:
        """The runner's local launch-profile allowlist."""
        data = self._request("GET", "/api/profiles")
        return [LaunchProfile.from_json(p) for p in data["profiles"]]

    # -- sessions -----------------------------------------------------------

    def list_sessions(self) -> list[Session]:
        data = self._request("GET", "/api/sessions")
        return [Session.from_json(s) for s in data["sessions"]]

    def spawn_session(
        self,
        profile_id: str,
        *,
        name: str | None = None,
        remote_control: bool = False,
        model: str | None = None,
    ) -> Session:
        """Spawn a session from a launch-profile id.

        With ``remote_control=True`` (tmux profiles only) the session runs
        ``claude --remote-control`` and appears as a Remote Control target on
        claude.ai. ``model`` (e.g. ``"sonnet"``) is exported as
        ``ANTHROPIC_MODEL`` in the session's environment so Claude starts on
        that model.
        """
        body: dict[str, Any] = {"profileId": profile_id}
        if name is not None:
            body["name"] = name
        if remote_control:
            body["remoteControl"] = True
        if model is not None:
            body["model"] = model
        data = self._request("POST", "/api/sessions", json=body)
        return Session.from_json(data["session"])

    def get_session(self, session_id: str) -> Session:
        data = self._request("GET", f"/api/sessions/{session_id}")
        return Session.from_json(data["session"])

    def kill_session(self, session_id: str) -> Session:
        data = self._request("DELETE", f"/api/sessions/{session_id}")
        return Session.from_json(data["session"])

    def send_input(self, session_id: str, message: str) -> None:
        """Dispatch one user turn to a headless session."""
        self._request("POST", f"/api/sessions/{session_id}/input", json={"message": message})

    def events(self, session_id: str, *, since: int = 0) -> list[SessionEvent]:
        """Events a headless session has emitted after sequence number `since`."""
        data = self._request("GET", f"/api/sessions/{session_id}/events", params={"since": since})
        return [SessionEvent.from_json(e) for e in data["events"]]

    def wait_for_events(
        self,
        session_id: str,
        *,
        since: int = 0,
        min_count: int = 1,
        timeout: float = 10.0,
        interval: float = 0.1,
    ) -> list[SessionEvent]:
        """Poll until at least `min_count` events after `since` exist."""
        deadline = time.monotonic() + timeout
        while True:
            found = self.events(session_id, since=since)
            if len(found) >= min_count:
                return found
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"expected {min_count} event(s) after seq {since} within {timeout}s, "
                    f"got {len(found)}"
                )
            time.sleep(interval)
