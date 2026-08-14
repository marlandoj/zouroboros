#!/usr/bin/env bash
# memory-gate-hook.sh — generic UserPromptSubmit hook for the Zouroboros memory gate.
#
# Wire this at your host's pre-prompt hook (e.g. Claude Code settings.json
# hooks.UserPromptSubmit). It calls the memory-gate daemon and, when prior
# context is found, prints it wrapped in <memory-gate>…</memory-gate> so the
# host injects it into the prompt.
#
# Contract (host-agnostic):
#   stdin  (host -> hook):  JSON { "prompt": "<text>", "persona": "<slug, optional>" }
#   call   (hook -> gate):  POST http://$HOST:$PORT/gate
#                           Authorization: Bearer $ZO_GATE_TOKEN
#                           body { "message": "<prompt>", "persona": "<slug>" }
#   resp   (gate -> hook):  JSON { "exit_code": 0|2|3|1, "output": "<context>", ... }
#   stdout (hook -> host):  if exit_code==0 && output:  <memory-gate>\n{output}\n</memory-gate>
#   exit                :  ALWAYS 0 — fail-open BY DESIGN.
#
# Why fail-open: the gate performs *additive* context injection, not access
# control. A failed, absent, or unreachable daemon must never block the user's
# prompt — proceeding without extra context is strictly better than blocking on
# a retrieval miss. There is nothing to "let through"; this is not a security
# gate.
#
# Config (all optional except a running daemon + token):
#   ZO_GATE_HOST     daemon host   (default 127.0.0.1)
#   ZO_GATE_PORT     daemon port   (default 7820)
#   ZO_GATE_TOKEN    bearer token  (or read from ~/.zouroboros/.env)
#   ZO_GATE_PERSONA  persona slug  (default: stdin .persona, else "shared")

HOST="${ZO_GATE_HOST:-127.0.0.1}"
PORT="${ZO_GATE_PORT:-7820}"
ENV_FILE="${ZOUROBOROS_ENV_FILE:-$HOME/.zouroboros/.env}"

# Resolve the bearer token: env first, then ~/.zouroboros/.env (init writes it there).
if [[ -z "${ZO_GATE_TOKEN:-}" && -f "$ENV_FILE" ]]; then
  ZO_GATE_TOKEN="$(grep -E '^ZO_GATE_TOKEN=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-)"
fi

INPUT="$(cat)"

# jq parses the host's JSON payload. Without it we cannot build a request, so
# fail open (inject nothing) rather than block.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // .message // empty' 2>/dev/null)"
[[ -z "$PROMPT" ]] && exit 0

PERSONA="${ZO_GATE_PERSONA:-$(printf '%s' "$INPUT" | jq -r '.persona // .persona_id // "shared"' 2>/dev/null)}"
[[ -z "$PERSONA" || "$PERSONA" == "null" ]] && PERSONA="shared"

PAYLOAD="$(jq -n --arg m "$PROMPT" --arg p "$PERSONA" '{message:$m, persona:$p}')"

AUTH_ARGS=()
if [[ -n "${ZO_GATE_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer $ZO_GATE_TOKEN")
fi

RESP="$(curl -sf -m 5 \
  -H 'Content-Type: application/json' \
  "${AUTH_ARGS[@]}" \
  -d "$PAYLOAD" \
  "http://$HOST:$PORT/gate" 2>/dev/null || true)"

[[ -z "$RESP" ]] && exit 0

EXIT_CODE="$(printf '%s' "$RESP" | jq -r '.exit_code // empty' 2>/dev/null)"
OUTPUT="$(printf '%s' "$RESP" | jq -r '.output // empty' 2>/dev/null)"

if [[ "$EXIT_CODE" == "0" && -n "$OUTPUT" ]]; then
  printf '<memory-gate>\n%s\n</memory-gate>\n' "$OUTPUT"
fi

exit 0
