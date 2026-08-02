"""Minimal MCP stdio client for E2E tests.

Speaks raw newline-delimited JSON-RPC to `ayvee-runner mcp`, so the tests
verify the actual wire protocol without depending on an MCP client library.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any


class McpStdioClient:
    def __init__(self, command: list[str], env: dict[str, str]) -> None:
        self.proc = subprocess.Popen(
            command,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._next_id = 0
        self.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "ayvee-runner-e2e", "version": "0"},
            },
        )
        self.notify("notifications/initialized")

    def _send(self, message: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                stderr = self.proc.stderr.read() if self.proc.stderr else ""
                raise RuntimeError(f"MCP server exited; stderr:\n{stderr}")
            response = json.loads(line)
            if response.get("id") == self._next_id:
                if "error" in response:
                    raise RuntimeError(f"MCP error: {response['error']}")
                return response["result"]

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call a tool and parse its JSON text content; raise on tool errors."""
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        text = result["content"][0]["text"]
        if result.get("isError"):
            raise RuntimeError(text)
        return json.loads(text)

    def list_tool_names(self) -> list[str]:
        return [t["name"] for t in self.request("tools/list")["tools"]]

    def close(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
