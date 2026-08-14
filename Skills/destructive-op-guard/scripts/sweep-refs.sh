#!/usr/bin/env bash
# sweep-refs.sh <identifier> [<identifier2> ...]
#
# After a teardown, grep /home/workspace for each removed identifier and classify
# every hit as live-config/code (review or fix) vs log/doc (leave). Exits 1 when any
# config/code hit needs review, 0 when the sweep is clean.
set -uo pipefail
WS="/home/workspace"

if [ "$#" -eq 0 ]; then
  echo "usage: sweep-refs.sh <identifier> [<identifier2> ...]" >&2
  echo "  e.g. sweep-refs.sh 203.0.113.10 <resource-id> old-box-name" >&2
  exit 2
fi

have_rg() { command -v rg >/dev/null 2>&1; }

classify() {
  case "$1" in
    *.jsonl|*.log|*routing-log*|*feedback.jsonl|*/logs/*)              echo "log " ;;
    *.md|*.txt|*README*|*CHANGELOG*|*/docs/*|*postflight*|*PROGRESS*)  echo "doc " ;;
    *.mcp.json|*.env|*.env.*|*.service|*.yml|*.yaml|*.tf|*.json)       echo "LIVE" ;;
    *.ts|*.js|*.sh|*.py)                                              echo "code" ;;
    *)                                                                echo "?   " ;;
  esac
}

rc=0
for id in "$@"; do
  echo "=== references to: $id ==="
  if have_rg; then
    hits="$(rg -l --no-ignore --hidden -F "$id" "$WS" -g '!**/.git/**' -g '!**/node_modules/**' 2>/dev/null)"
  else
    hits="$(grep -rlF "$id" "$WS" --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null)"
  fi
  if [ -z "$hits" ]; then
    echo "  (none — clean)"
    continue
  fi
  live=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    tag="$(classify "$f")"
    printf "  [%s] %s\n" "$tag" "${f#"$WS"/}"
    case "$tag" in LIVE|code) live=$((live + 1)) ;; esac
  done <<< "$hits"
  if [ "$live" -gt 0 ]; then
    echo "  ^ $live config/code hit(s) — review each: live dependency (fix) or reprovision-path/expected (leave)?"
    rc=1
  fi
done
exit "$rc"
