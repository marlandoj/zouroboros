#!/usr/bin/env python3
"""
Claude Code PostToolUse hook -> tool_calls.

Captures every tool call (Bash, Read, Grep, Edit, Write, mcp__*) into the
shared tool_calls table so M10 / Tool2Vec instrumentation has real data.
Swarm task outcomes live in a separate table (`swarm_task_evals`).

Hook contract: stdin is JSON with keys:
  session_id, transcript_path, hook_event_name, tool_name, tool_input,
  tool_response, optionally tool_use_id.

Failures are silenced — never block Claude. Logs to /tmp/post-tool-eval-hook.log.
"""

import json
import os
import sqlite3
import sys
import time
import traceback
import uuid

DB_PATH = os.environ.get(
    "ZOUROBOROS_MEMORY_DB",
    "/home/workspace/.zo/memory/shared-facts.db",
)
LOG_PATH = "/tmp/post-tool-eval-hook.log"
START_DIR = "/tmp/tool-eval-starts"

MAX_ARGS = 1000
MAX_ERR_TYPE = 200
MAX_ERR_MSG = 500
MAX_PERSONA = 100
MAX_SESSION = 100


def log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def reconcile_duration_ms(session_id: str, tool_use_id: str) -> int | None:
    """Read + delete the PreToolUse sidecar to compute elapsed ms."""
    if not tool_use_id:
        return None
    safe_session = (session_id or "no-session").replace("/", "_")[:80]
    safe_tu = (tool_use_id or "no-tu").replace("/", "_")[:80]
    path = os.path.join(START_DIR, f"{safe_session}-{safe_tu}.ts")
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r") as f:
            start_ms = int(f.read().strip())
        try:
            os.remove(path)
        except Exception:
            pass
        now_ms = int(time.time() * 1000)
        delta = now_ms - start_ms
        if delta < 0 or delta > 24 * 60 * 60 * 1000:
            return None
        return delta
    except Exception as e:
        log(f"reconcile failed for {tool_use_id}: {e}")
        return None


def classify_error(msg: str) -> str:
    m = (msg or "").lower()
    if "timeout" in m or "timed out" in m:
        return "timeout"
    if "not found" in m or "404" in m or "does not exist" in m:
        return "not_found"
    if "permission" in m or "unauthorized" in m or "forbidden" in m or "403" in m:
        return "permission_denied"
    if "expected string" in m or "expected number" in m:
        return "type_mismatch"
    if "required" in m or "missing" in m:
        return "missing_required_arg"
    if "schema" in m or "invalid argument" in m or "invalid param" in m:
        return "schema_mismatch"
    if "api" in m or "500" in m or "503" in m or "rate limit" in m:
        return "api_error"
    return "other"


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except Exception as e:
        log(f"input parse failed: {e}")
        return 0

    tool_name = (payload.get("tool_name") or "").strip()
    if not tool_name:
        return 0

    tool_input = payload.get("tool_input") or {}
    tool_response = payload.get("tool_response") or {}
    session_id = (payload.get("session_id") or "")[:MAX_SESSION]
    tool_use_id = payload.get("tool_use_id") or ""
    duration_ms = reconcile_duration_ms(session_id, tool_use_id)

    is_error = False
    err_msg = ""
    if isinstance(tool_response, dict):
        if tool_response.get("is_error"):
            is_error = True
            err_msg = str(tool_response.get("content") or tool_response.get("error") or "")[:MAX_ERR_MSG]
        elif tool_response.get("error"):
            is_error = True
            err_msg = str(tool_response.get("error"))[:MAX_ERR_MSG]
    elif isinstance(tool_response, str) and tool_response.lower().startswith("error"):
        is_error = True
        err_msg = tool_response[:MAX_ERR_MSG]

    outcome = "failure" if is_error else "success"
    error_type = classify_error(err_msg)[:MAX_ERR_TYPE] if is_error else ""

    try:
        args_json = json.dumps(tool_input, default=str)[:MAX_ARGS]
    except Exception:
        args_json = ""

    persona = (os.environ.get("ZO_ACTIVE_PERSONA") or "claude-code")[:MAX_PERSONA]

    row = (
        str(uuid.uuid4()),
        tool_name,
        args_json,
        outcome,
        None,
        None,
        None,
        error_type or None,
        err_msg or None,
        duration_ms,
        persona,
        session_id or None,
    )

    try:
        conn = sqlite3.connect(DB_PATH, timeout=2.0)
        try:
            conn.execute(
                "INSERT INTO tool_calls("
                "id, tool_name, tool_args, outcome, "
                "precision_score, recall_score, argument_accuracy, "
                "error_type, error_message, duration_ms, persona, session_id"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                row,
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        log(f"insert failed for {tool_name}: {e}\n{traceback.format_exc()}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"top-level failure: {e}")
        sys.exit(0)
