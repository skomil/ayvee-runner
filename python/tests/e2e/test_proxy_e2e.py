"""E2E: the dashboard works behind a reverse proxy on a path prefix.

A tiny threaded proxy serves the runner under `/runners/vm/`, stripping the
prefix before forwarding. Because every asset and API call in the dashboard is
relative, the page loads and reads status through the prefix unchanged.
"""

from __future__ import annotations

import re
import shutil
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urljoin

import httpx
import pytest

from .conftest import Runner

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")

PREFIX = "/runners/vm/"


@pytest.fixture
def proxy(runner: Runner) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
            if not self.path.startswith(PREFIX):
                self.send_error(404)
                return
            forwarded = (
                {"Authorization": self.headers["Authorization"]}
                if self.headers.get("Authorization")
                else {}
            )
            upstream = httpx.get(
                f"{runner.url}/{self.path[len(PREFIX):]}", headers=forwarded, timeout=10
            )
            body = upstream.content
            self.send_response(upstream.status_code)
            self.send_header("Content-Type", upstream.headers.get("content-type", "text/plain"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = HTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}{PREFIX}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class TestProxyPathPrefix:
    def test_dashboard_assets_are_relative_and_resolve_through_the_prefix(
        self, proxy: str
    ) -> None:
        page = httpx.get(proxy)
        assert page.status_code == 200
        assert "<h1>ayvee-runner</h1>" in page.text

        refs = re.findall(r'(?:href|src)="([^"]+)"', page.text)
        assert refs, "dashboard referenced no assets"
        for ref in refs:
            # An absolute path would escape the proxy prefix entirely.
            assert not ref.startswith("/"), f"absolute asset path: {ref}"
            asset = httpx.get(urljoin(proxy, ref))
            assert asset.status_code == 200, ref

    def test_bundle_uses_a_relative_api_base(self, proxy: str) -> None:
        bundle = httpx.get(urljoin(proxy, "dashboard.js"))
        assert bundle.status_code == 200
        assert "document.baseURI" in bundle.text
        assert '"/api' not in bundle.text and "`/api" not in bundle.text

    def test_status_api_is_reachable_anonymously_through_the_prefix(self, proxy: str) -> None:
        health = httpx.get(urljoin(proxy, "api/health"))
        assert health.status_code == 200
        assert health.json()["name"] == "e2e test runner"
        metrics = httpx.get(urljoin(proxy, "api/metrics"))
        assert metrics.status_code == 200
        assert metrics.json()["claude"]["windowHours"] == 5

    def test_managed_api_still_requires_the_key_through_the_prefix(
        self, proxy: str, runner: Runner
    ) -> None:
        assert httpx.get(urljoin(proxy, "api/sessions")).status_code == 401
        authed = httpx.get(
            urljoin(proxy, "api/sessions"), headers={"Authorization": f"Bearer {runner.key}"}
        )
        assert authed.status_code == 200
