#!/usr/bin/env python3
"""
Claude Code PreToolUse hook -> records tool-call start time.

Companion to post-tool-eval-hook.py. Writes a sidecar file at
/tmp/tool-eval-starts/<session>-<tool_use_id>.ts containing the epoch-ms
start timestamp. PostToolUse reads + deletes the sidecar to compute
duration_ms.

Hook contract: stdin is JSON with keys:
  session_id, transcript_path, hook_event_name, tool_name, tool_input,
  optionally tool_use_id.

Failures are silenced — never block Claude. Logs to /tmp/pre-tool-eval-hook.log.
"""

import json
import os
import sys
import time

START_DIR = "/tmp/tool-eval-starts"
LOG_PATH = "/tmp/pre-tool-eval-hook.log"


def log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def sidecar_path(session_id: str, tool_use_id: str) -> str:
    safe_session = (session_id or "no-session").replace("/", "_")[:80]
    safe_tu = (tool_use_id or "no-tu").replace("/", "_")[:80]
    return os.path.join(START_DIR, f"{safe_session}-{safe_tu}.ts")


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except Exception as e:
        log(f"input parse failed: {e}")
        return 0

    tool_use_id = payload.get("tool_use_id") or ""
    session_id = payload.get("session_id") or ""

    # Fall back to a synthetic key if tool_use_id missing — at least we capture
    # something queryable when reconciliation lands in PostToolUse.
    if not tool_use_id:
        tool_use_id = f"synth-{int(time.time() * 1000)}"

    try:
        os.makedirs(START_DIR, exist_ok=True)
        path = sidecar_path(session_id, tool_use_id)
        with open(path, "w") as f:
            f.write(str(int(time.time() * 1000)))
    except Exception as e:
        log(f"write start sidecar failed: {e}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"top-level failure: {e}")
        sys.exit(0)
