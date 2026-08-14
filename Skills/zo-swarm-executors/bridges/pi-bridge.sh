#!/usr/bin/env bash
set -euo pipefail

PROMPT="${1:?Usage: pi-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/home/workspace}"
TIMEOUT="${PI_TIMEOUT:-600}"
MODEL="${PI_MODEL:-${SWARM_RESOLVED_MODEL:-openrouter/moonshotai/kimi-k3}}"

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi not found" >&2
  exit 1
fi

case "$MODEL" in
  byok:*|swarm-*|trivial|simple|moderate|complex|light|mid|heavy|failover)
    MODEL="openrouter/moonshotai/kimi-k3"
    ;;
esac

cd "$WORKDIR"
export PI_TELEMETRY="${PI_TELEMETRY:-0}"
export PI_SKIP_VERSION_CHECK="${PI_SKIP_VERSION_CHECK:-1}"

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

if timeout --signal=TERM --kill-after=10s "$TIMEOUT" \
  pi --print --no-session --approve --model "$MODEL" "$PROMPT" \
  >"$OUTPUT_FILE" 2>&1; then
  cat "$OUTPUT_FILE"
else
  status=$?
  cat "$OUTPUT_FILE" >&2
  exit "$status"
fi
