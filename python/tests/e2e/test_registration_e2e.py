"""E2E: an Ayvee server discovers the runner and registers itself.

Everything runs through the Python library against the real server, following
the flow an Ayvee deployment would: read the anonymous advert to learn the
register URL and capabilities, POST a registration with the key, then confirm
it is listed, idempotent, persisted on disk, and removable.
"""

from __future__ import annotations

import json
import shutil

import httpx
import pytest

from ayvee_runner_client import RunnerAPIError, RunnerAuthError, RunnerClient

from .conftest import Runner

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


@pytest.fixture(autouse=True)
def clean_registrations(client: RunnerClient) -> None:
    for registration in client.list_registrations():
        client.unregister(registration.id)


class TestAdvert:
    def test_advert_is_anonymous_and_describes_the_runner(self, runner: Runner) -> None:
        with runner.client(key="ayr_not_a_key") as anonymous:
            descriptor = anonymous.registration()
        assert descriptor.name == "e2e test runner"
        assert descriptor.version == "0.1.0"
        assert descriptor.runner_id
        assert descriptor.register_url == f"{runner.url}/api/register"
        assert descriptor.capabilities["sessionKinds"] == ["tmux", "headless"]
        assert descriptor.capabilities["remoteControl"] is True
        assert descriptor.capabilities["modelSelection"] is True

    def test_runner_id_is_stable_across_calls(self, client: RunnerClient) -> None:
        assert client.registration().runner_id == client.registration().runner_id

    def test_advert_url_follows_proxy_headers(self, runner: Runner) -> None:
        res = httpx.get(
            f"{runner.url}/api/registration",
            headers={"X-Forwarded-Proto": "https", "X-Forwarded-Prefix": "/runners/vm"},
        )
        assert res.json()["registerUrl"].endswith("/runners/vm/api/register")
        assert res.json()["registerUrl"].startswith("https://")


class TestRegistrationFlow:
    def test_ayvee_server_registers_and_is_listed(self, client: RunnerClient) -> None:
        registration = client.register("https://ayvee.example.com", label="prod")
        assert registration.ayvee_url == "https://ayvee.example.com"
        assert registration.label == "prod"
        assert registration.registered_at

        listed = client.list_registrations()
        assert [r.id for r in listed] == [registration.id]

    def test_registering_twice_refreshes_rather_than_duplicates(
        self, client: RunnerClient
    ) -> None:
        first = client.register("https://ayvee.example.com")
        again = client.register("https://ayvee.example.com", label="retry")
        assert again.id == first.id
        listed = client.list_registrations()
        assert len(listed) == 1
        assert listed[0].label == "retry"

    def test_registration_is_persisted_on_disk(
        self, client: RunnerClient, runner: Runner
    ) -> None:
        client.register("https://ayvee.example.com", label="durable")
        stored = json.loads((runner.home / "registrations.json").read_text())["registrations"]
        assert [r["label"] for r in stored] == ["durable"]

    def test_unregister_removes_it(self, client: RunnerClient) -> None:
        registration = client.register("https://ayvee.example.com")
        client.unregister(registration.id)
        assert client.list_registrations() == []

    def test_invalid_ayvee_urls_are_rejected(self, client: RunnerClient) -> None:
        for bad in ["", "not a url", "ftp://ayvee.example.com"]:
            with pytest.raises(RunnerAPIError):
                client.register(bad)
        assert client.list_registrations() == []


class TestRegistrationAuth:
    def test_registering_requires_the_key(self, runner: Runner, client: RunnerClient) -> None:
        with runner.client(key="ayr_attacker") as intruder:
            with pytest.raises(RunnerAuthError):
                intruder.register("https://attacker.example.com")
            with pytest.raises(RunnerAuthError):
                intruder.list_registrations()
            with pytest.raises(RunnerAuthError):
                intruder.unregister("any-id")
        assert client.list_registrations() == []
