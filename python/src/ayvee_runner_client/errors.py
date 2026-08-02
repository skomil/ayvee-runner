"""Errors raised by the runner client."""

from __future__ import annotations


class RunnerError(Exception):
    """Base class for all runner client errors."""


class RunnerConnectionError(RunnerError):
    """The runner could not be reached at all."""


class RunnerAPIError(RunnerError):
    """The runner answered with an error status."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"{status_code}: {message}")
        self.status_code = status_code
        self.message = message


class RunnerAuthError(RunnerAPIError):
    """The API key was missing, wrong, or not yet minted (401/503)."""


class SessionNotFoundError(RunnerAPIError):
    """No session with the given id (404)."""
