#!/usr/bin/env python3
"""Offline replay of critic_live decision handling. No network and no token read."""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path


def main() -> None:
    root = Path(sys.argv[1])
    sys.path.insert(0, str(root))
    import critic_live

    critic_live._load_xai_token = lambda: "offline-stub"
    original_call = critic_live._critic_call
    case = json.loads(sys.argv[2])
    action = json.loads(sys.argv[3])
    verdicts = json.loads(sys.argv[4])

    def stub(verdict: str):
        def _call(token: str, model: str, user: str) -> dict:
            if token != "offline-stub":
                raise SystemExit("stub token was replaced")
            return {
                "ok": True,
                "execute": True,
                "verdict": verdict,
                "reasons": ["probe"],
                "ms": 3,
                "http": 200,
                "model": model,
                "usage": None,
                "raw": "",
            }

        return _call

    rows = []
    if case.get("world") is not None:
        for verdict in verdicts:
            critic_live._critic_call = stub(verdict)
            out = critic_live.critic_live(case, action, "initial", model="grok-4-fast-reasoning")
            critic = out.get("critic") or {}
            rows.append(
                {
                    "input_execute": True,
                    "input_verdict": verdict,
                    "envelope_verdict": out.get("verdict"),
                    "envelope_execute": out.get("execute"),
                    "critic_called": critic.get("skipped") is not True,
                    "raw_verdict": critic.get("raw_verdict"),
                    "raw_execute": critic.get("raw_execute"),
                }
            )

    user = critic_live.build_critic_user(case, action)
    captured: dict = {}

    def capture(req, timeout=None, context=None):
        captured["body"] = json.loads(req.data.decode())
        raise RuntimeError("offline-stop")

    urllib.request.urlopen = capture
    stopped = original_call("offline-stub", "grok-4-fast-reasoning", user)
    if "body" not in captured or stopped.get("ok") is not False:
        raise SystemExit("request body was not captured offline")
    body = captured["body"]
    json.dump({"rows": rows, "request": body}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
