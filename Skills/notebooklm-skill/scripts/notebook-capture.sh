#!/usr/bin/env bash
# notebook-capture — one-line wrapper for scheduled agents to append their output
# to a per-agent NotebookLM notebook.
#
# Usage:
#   notebook-capture <agent-slug> --file path/to/output.md
#   notebook-capture <agent-slug> --title "2026-04-22 brief" <<< "markdown content"
#   command-that-prints-report | notebook-capture <agent-slug> --title "daily brief"
#
# The notebook is auto-created on first use. Subsequent calls append new sources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="python3.12"

if [[ $# -lt 1 ]]; then
    echo "usage: notebook-capture <agent-slug> [--file PATH] [--title TITLE] [--tag TAG]..." >&2
    echo "       echo 'content' | notebook-capture <agent-slug>" >&2
    exit 2
fi

AGENT="$1"
shift

ARGS=("append" "$AGENT")
FILE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --file) FILE="$2"; ARGS+=("--file" "$2"); shift 2 ;;
        --title) ARGS+=("--title" "$2"); shift 2 ;;
        --tag) ARGS+=("--tag" "$2"); shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [[ -z "$FILE" ]]; then
    ARGS+=("--stdin")
    exec "$PY" "$SCRIPT_DIR/agent_research.py" "${ARGS[@]}"
else
    exec "$PY" "$SCRIPT_DIR/agent_research.py" "${ARGS[@]}"
fi
