# ayvee-runner-client

Python client for the [ayvee-runner](https://github.com/ayvee/ayvee-runner) service — the
per-user runner that spawns, lists, and kills tmux and headless Claude Code sessions on your
own machine.

```python
from ayvee_runner_client import RunnerClient

with RunnerClient("http://127.0.0.1:7777", api_key="ayr_...") as client:
    client.wait_healthy()

    for profile in client.list_profiles():
        print(profile.id, profile.kind, profile.label)

    session = client.spawn_session("dev-shell")
    print(session.tmux_name)          # tmux attach -t <name>

    agent = client.spawn_session("kb-agent")
    client.send_input(agent.id, "Review the tag taxonomy")
    for event in client.wait_for_events(agent.id):
        print(event.data)

    client.kill_session(session.id)
```

The API key is minted on the runner machine with `ayvee-runner mint-key`; rotating it there
invalidates the old key immediately.
