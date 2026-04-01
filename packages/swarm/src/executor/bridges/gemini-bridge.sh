#!/usr/bin/env bash
# Gemini CLI bridge script — invokes Gemini CLI in one-shot (headless) mode
# Routes through OmniRoute for access to swarm combos and shared memory via MCP
# If the gemini-daemon is running, routes through it for ~10x faster startup.
# Falls back to direct CLI invocation otherwise.
#
# Usage:
#   ./gemini-bridge.sh "Your prompt here"
#   ./gemini-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   GEMINI_MODEL       — override model (supports swarm combos or gemini-* models)
#   GEMINI_TIMEOUT     — timeout in seconds (default: 300)
#   GEMINI_NO_DAEMON   — set to '1' to skip daemon and use direct CLI

set -euo pipefail

PROMPT="${1:?Usage: gemini-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/home/workspace}"
DEFAULT_MODEL="gemini-2.5-flash"

# --- Dynamic OmniRoute model resolution ---
# Priority: OmniRoute dynamic > SWARM_RESOLVED_MODEL > GEMINI_MODEL > default
_SWARM_MODEL="${SWARM_RESOLVED_MODEL:-}"
_GEMINI_MODEL="${GEMINI_MODEL:-}"
TIER="${SWARM_TIER:-}"

# Attempt dynamic resolution via OmniRoute tier-resolve.ts
TIER_RESOLVE_SCRIPT="/home/workspace/Skills/zo-swarm-orchestrator/scripts/tier-resolve.ts"
if [ -f "$TIER_RESOLVE_SCRIPT" ] && command -v bun &>/dev/null; then
  RESOLVED_JSON=$(timeout 15 bun "$TIER_RESOLVE_SCRIPT" --omniroute "$PROMPT" --json 2>/dev/null) || true
  if [ -n "${RESOLVED_JSON:-}" ]; then
    OMNIROUTE_COMBO=$(echo "$RESOLVED_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('resolvedCombo',''))" 2>/dev/null) || true
    OMNIROUTE_TIER=$(echo "$RESOLVED_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('complexity',{}).get('tier',''))" 2>/dev/null) || true
    if [ -n "${OMNIROUTE_COMBO:-}" ]; then
      _SWARM_MODEL="$OMNIROUTE_COMBO"
    fi
    if [ -z "$TIER" ] && [ -n "${OMNIROUTE_TIER:-}" ]; then
      TIER="$OMNIROUTE_TIER"
    fi
  fi
fi

# --- Per-tier timeout resolution ---
if [ -n "${GEMINI_TIMEOUT:-}" ]; then
  TIMEOUT="$GEMINI_TIMEOUT"
else
  case "${TIER:-}" in
    trivial|swarm-light)          TIMEOUT=120 ;;
    simple|moderate|swarm-mid)    TIMEOUT=300 ;;
    complex|swarm-heavy)          TIMEOUT=600 ;;
    *)                            TIMEOUT=300 ;;
  esac
fi

# Resolve model: accept only Gemini-native names (gemini-* or gc/*).
# Map swarm tier names to Gemini model aliases
# swarm-light  → gemini-2.5-flash
# swarm-mid    → gemini-3-pro-preview
# swarm-heavy  → gemini-3-pro-preview
# swarm-failover → gemini-2.5-flash

case "$_SWARM_MODEL" in
  swarm-light)    MODEL="gemini-2.5-flash" ;;
  swarm-mid)      MODEL="gemini-3-pro-preview" ;;
  swarm-heavy)    MODEL="gemini-3-pro-preview" ;;
  swarm-failover) MODEL="gemini-2.5-flash" ;;
  swarm-*)        MODEL="gemini-2.5-flash" ;;
  light)          MODEL="gemini-2.5-flash" ;;
  mid)            MODEL="gemini-3-pro-preview" ;;
  heavy)          MODEL="gemini-3-pro-preview" ;;
  failover)       MODEL="gemini-2.5-flash" ;;
  gemini*|gc/*|models/*) MODEL="${_SWARM_MODEL#gc/}" ;;
  "")
    case "$_GEMINI_MODEL" in
      swarm-light)    MODEL="gemini-2.5-flash" ;;
      swarm-mid)      MODEL="gemini-3-pro-preview" ;;
      swarm-heavy)    MODEL="gemini-3-pro-preview" ;;
      swarm-failover) MODEL="gemini-2.5-flash" ;;
      swarm-*)        MODEL="gemini-2.5-flash" ;;
      gemini*|gc/*|models/*) MODEL="${_GEMINI_MODEL#gc/}" ;;
      "")             MODEL="$DEFAULT_MODEL" ;;
      *)
        echo "BRIDGE_WARN: ignoring non-Gemini model '$_GEMINI_MODEL', using default '$DEFAULT_MODEL'" >&2
        MODEL="$DEFAULT_MODEL"
        ;;
    esac
    ;;
  *)
    echo "BRIDGE_WARN: ignoring non-Gemini model '$_SWARM_MODEL', using default '$DEFAULT_MODEL'" >&2
    MODEL="$DEFAULT_MODEL"
    ;;
esac

# --- Spec 2: Capture start time for duration metrics ---
START_TIME=$(date +%s%N)

# --- Spec 2: Helper to write result.json ---
_write_result() {
  local _STATUS="$1"
  local _OUTPUT="$2"
  local _ERROR_MSG="${3:-}"
  local _RESULT_FILE="${RESULT_PATH:-result.json}"
  local _RESULT_TMP="${_RESULT_FILE}.tmp"
  local _TASK_ID="${SWARM_TASK_ID:-unknown}"
  local _TIMESTAMP
  _TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local _DURATION_MS=0
  if [ -n "${START_TIME:-}" ]; then
    local _END_TIME
    _END_TIME=$(date +%s%N)
    _DURATION_MS=$(( (_END_TIME - START_TIME) / 1000000 ))
  fi

  if [ "$_STATUS" = "success" ]; then
    cat > "$_RESULT_TMP" <<RESULT_EOF
{
  "status": "success",
  "output": $(echo "$_OUTPUT" | head -c 102400 | jq -Rs .),
  "metrics": {
    "durationMs": $_DURATION_MS,
    "model": $(echo "$MODEL" | jq -Rs .)
  },
  "executorId": "gemini",
  "taskId": "$_TASK_ID",
  "timestamp": "$_TIMESTAMP"
}
RESULT_EOF
  else
    cat > "$_RESULT_TMP" <<RESULT_EOF
{
  "status": "failure",
  "output": "",
  "error": {
    "category": "unknown",
    "message": $(echo "$_ERROR_MSG" | head -c 2000 | jq -Rs .),
    "retryable": true
  },
  "metrics": {
    "durationMs": $_DURATION_MS,
    "model": $(echo "$MODEL" | jq -Rs .)
  },
  "executorId": "gemini",
  "taskId": "$_TASK_ID",
  "timestamp": "$_TIMESTAMP"
}
RESULT_EOF
  fi
  mv "$_RESULT_TMP" "$_RESULT_FILE"
}

DAEMON_SOCKET="/tmp/gemini-daemon.sock"

# --- Daemon path: ~1-2s per call instead of ~12s ---
if [ "${GEMINI_NO_DAEMON:-}" != "1" ] && [ -S "$DAEMON_SOCKET" ]; then
  RESPONSE=$(curl -s --unix-socket "$DAEMON_SOCKET" \
    -X POST http://localhost/prompt \
    -H 'Content-Type: application/json' \
    --max-time "$TIMEOUT" \
    -d "$(jq -n --arg p "$PROMPT" --arg m "$MODEL" --arg w "$WORKDIR" \
         '{prompt: $p, model: $m, workdir: $w}')" 2>/dev/null) || true

  if [ -n "$RESPONSE" ]; then
    ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
    if [ -z "$ERROR" ]; then
      DAEMON_OUTPUT=$(echo "$RESPONSE" | jq -r '.output // empty' 2>/dev/null)
      echo "$DAEMON_OUTPUT"
      _write_result "success" "$DAEMON_OUTPUT"
      exit 0
    fi
    echo "BRIDGE_WARN: daemon returned error: $ERROR, falling back to direct CLI" >&2
  fi
fi

# --- Direct CLI fallback ---
GEMINI_BIN=""
if command -v gemini &>/dev/null; then
  GEMINI_BIN="gemini"
elif [ -x "/usr/bin/gemini" ]; then
  GEMINI_BIN="/usr/bin/gemini"
elif [ -x "/usr/local/bin/gemini" ]; then
  GEMINI_BIN="/usr/local/bin/gemini"
elif [ -x "$HOME/.local/bin/gemini" ]; then
  GEMINI_BIN="$HOME/.local/bin/gemini"
else
  echo "ERROR: gemini binary not found. Install with: npm install -g @google/gemini-cli" >&2
  exit 1
fi

cd "$WORKDIR"
STDERR_LOG="/tmp/gemini-bridge-stderr-$$.log"

CLI_OUTPUT_FILE="/tmp/gemini-bridge-output-$$.txt"
EXIT_CODE=0
timeout "$TIMEOUT" "$GEMINI_BIN" -p "$PROMPT" --yolo --output-format text -m "$MODEL" --sandbox=false 2>"$STDERR_LOG" > "$CLI_OUTPUT_FILE" || EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "BRIDGE_WARN: direct CLI failed (exit=$EXIT_CODE), trying OmniRoute fallback..." >&2
  CLI_STDERR=$(cat "$STDERR_LOG" 2>/dev/null | head -5)
  echo "BRIDGE_WARN: CLI stderr: $CLI_STDERR" >&2
  rm -f "$STDERR_LOG"

  # --- OmniRoute HTTP fallback ---
  # Route through OmniRoute proxy which has its own Gemini API keys configured
  OMNIROUTE_URL="${OMNIROUTE_URL:-http://localhost:20128}"
  OMNIROUTE_MODEL="gc/$MODEL"

  OR_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
    -X POST "${OMNIROUTE_URL}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg m "$OMNIROUTE_MODEL" --arg p "$PROMPT" \
         '{model: $m, messages: [{role: "user", content: $p}], stream: false}')" 2>/dev/null) || true

  if [ -n "$OR_RESPONSE" ]; then
    OR_ERROR=$(echo "$OR_RESPONSE" | jq -r '.error.message // empty' 2>/dev/null)
    if [ -z "$OR_ERROR" ]; then
      OR_CONTENT=$(echo "$OR_RESPONSE" | jq -r '.choices[0].message.content // empty' 2>/dev/null)
      if [ -n "$OR_CONTENT" ]; then
        echo "$OR_CONTENT"
        _write_result "success" "$OR_CONTENT"
        rm -f "$CLI_OUTPUT_FILE"
        exit 0
      fi
    fi
    echo "BRIDGE_WARN: OmniRoute fallback error: ${OR_ERROR:-empty response}" >&2
  fi

  echo "BRIDGE_ERROR: all paths failed (direct CLI exit=$EXIT_CODE, OmniRoute fallback failed)" >&2
  _write_result "failure" "" "all paths failed (direct CLI exit=$EXIT_CODE, OmniRoute fallback failed)"
  rm -f "$CLI_OUTPUT_FILE"
  exit $EXIT_CODE
fi

# Direct CLI succeeded
cat "$CLI_OUTPUT_FILE"
_write_result "success" "$(cat "$CLI_OUTPUT_FILE" 2>/dev/null)"
rm -f "$STDERR_LOG" "$CLI_OUTPUT_FILE"
exit 0
