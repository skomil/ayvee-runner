"""Stand-in for a persistent headless `claude -p --input-format=stream-json` process.

Emits an init event on start, then answers every stream-json user turn with an
assistant message and a result line, exactly like the real headless protocol.
"""

import json
import sys


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


emit({"type": "system", "subtype": "init", "session_id": "fake-claude"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    turn = json.loads(line)
    text = turn["message"]["content"][0]["text"]
    reply = f"echo: {text}"
    emit(
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": reply}],
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 34,
                    "cache_creation_input_tokens": 56,
                    "cache_read_input_tokens": 78,
                },
            },
        }
    )
    emit({"type": "result", "subtype": "success", "result": reply})
