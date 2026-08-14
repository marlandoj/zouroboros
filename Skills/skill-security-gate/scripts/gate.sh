#!/usr/bin/env bash
# Skill Security Gate — thin wrapper over NVIDIA SkillSpector.
# Usage:
#   gate.sh <path-or-git-url>   Pre-adoption scan of one skill (terminal + JSON report)
#   gate.sh --skills            Recursive baseline scan of /home/workspace/Skills
#   gate.sh --llm <target>      Include LLM semantic analysis (needs ANTHROPIC_API_KEY)
set -euo pipefail

export PATH="/root/.local/bin:$PATH"

REPORT_DIR="/home/workspace/Integrations/skillspector/reports"
mkdir -p "$REPORT_DIR"
DATE="$(date +%F)"

if ! command -v skillspector >/dev/null 2>&1; then
  echo "error: skillspector not found. Install with:" >&2
  echo "  uv tool install --python 3.12 /home/workspace/Integrations/skillspector" >&2
  exit 127
fi

LLM_FLAG="--no-llm"
if [ "${1:-}" = "--llm" ]; then
  LLM_FLAG=""
  shift
fi

if [ "${1:-}" = "--skills" ]; then
  OUT="$REPORT_DIR/skills-scan-${DATE}.json"
  echo "Baseline recursive scan of /home/workspace/Skills -> $OUT"
  skillspector scan /home/workspace/Skills --recursive $LLM_FLAG --format json -o "$OUT"
  echo "Report: $OUT"
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: gate.sh <path-or-git-url> | --skills | --llm <target>" >&2
  exit 2
fi

SLUG="$(echo "$TARGET" | sed -E 's#[^a-zA-Z0-9._-]+#-#g' | sed -E 's#^-+|-+$##g' | tail -c 60)"
OUT="$REPORT_DIR/adopt-${SLUG}-${DATE}.json"

echo "=== Pre-adoption scan: $TARGET ==="
skillspector scan "$TARGET" $LLM_FLAG --format terminal
echo "=== Saving JSON report -> $OUT ==="
skillspector scan "$TARGET" $LLM_FLAG --format json -o "$OUT"
echo "Report: $OUT"
