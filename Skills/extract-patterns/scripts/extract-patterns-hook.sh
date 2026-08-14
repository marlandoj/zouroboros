#!/usr/bin/env bash
# ZOU-452 — Extract-Patterns Discipline: noise-free session pattern gate.
#
# Claude Code hook, registered for BOTH Stop and SessionEnd (branches on
# hook_event_name from stdin JSON):
#
#   Stop       — once per session, after the transcript crosses a size
#                threshold, emits {"decision":"block","reason":<gate prompt>}
#                asking the agent to run the four-criteria pattern review.
#                Sub-threshold stops exit silently (the session may still
#                grow); the stop_hook_active + per-session sentinel guards
#                make it a single nudge, never a loop.
#   SessionEnd — never blocks; writes the session's final decision line to
#                the log if the agent never reached / never resolved the gate,
#                so every session has exactly one recorded outcome.
#
# The four qualifying criteria (ALL required to extract):
#   1. project-specific  2. repeatedly applicable  3. non-obvious  4. trigger→action
# If not all four: the agent writes NOTHING and replies "No new patterns to extract."
#
# Routing: instinct-harvester store if present (ZOU-451), else
# Projects/lessons-learned.md. Decision log: /dev/shm/extract-patterns.log.
# Kill switch: touch /home/workspace/.claude/extract-patterns.off (or
# EXTRACT_PATTERNS_OFF=1). Fails open on any error.
set -u

WS="/home/workspace"
LOG="/dev/shm/extract-patterns.log"
SENTINEL_DIR="/dev/shm/extract-patterns"
OFF_FILE="$WS/.claude/extract-patterns.off"
INSTINCTS="$WS/.zo/instincts/instincts.yaml"
LESSONS="$WS/Projects/lessons-learned.md"
MIN_LINES="${EXTRACT_PATTERNS_MIN_LINES:-40}"

[[ "${EXTRACT_PATTERNS_OFF:-0}" == "1" || -f "$OFF_FILE" ]] && exit 0

INPUT=$(cat 2>/dev/null) || exit 0
jqf() { printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null; }

EVENT=$(jqf '.hook_event_name')
SID=$(jqf '.session_id')
[[ -z "$SID" ]] && exit 0

mkdir -p "$SENTINEL_DIR" 2>/dev/null || exit 0
PROMPTED="$SENTINEL_DIR/$SID.prompted"
NOW=$(date -u +%FT%TZ)

if [[ "$EVENT" == "SessionEnd" ]]; then
  # Close the books: every session gets exactly one final decision line.
  if grep -q "session=$SID decision=\(extracted\|none\)" "$LOG" 2>/dev/null; then
    exit 0
  elif [[ -f "$PROMPTED" ]]; then
    echo "$NOW session=$SID decision=prompted-unresolved" >> "$LOG" 2>/dev/null
  else
    echo "$NOW session=$SID decision=no-review reason=below-threshold" >> "$LOG" 2>/dev/null
  fi
  exit 0
fi

# --- Stop event ---
ACTIVE=$(jqf '.stop_hook_active')
[[ "$ACTIVE" == "true" ]] && exit 0          # loop guard: one nudge per stop cycle
[[ -f "$PROMPTED" ]] && exit 0               # once per session

TRANSCRIPT=$(jqf '.transcript_path')
LINES=0
[[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]] && LINES=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
[[ "$LINES" -lt "$MIN_LINES" ]] && exit 0    # too small to review yet; may cross later

touch "$PROMPTED" 2>/dev/null
echo "$NOW session=$SID decision=prompted lines=$LINES" >> "$LOG" 2>/dev/null

if [[ -f "$INSTINCTS" ]]; then
  ROUTE="run: bun $WS/Skills/instinct-harvester/scripts/observer.ts add --trigger \"<when doing X in context Y>\" --action \"<prefer Z>\" --domain <domain> --confidence <0.5-0.9> --source session-observation"
else
  ROUTE="append it to $LESSONS using the '## [YYYY-MM-DD] Trigger: ...' entry format documented at the top of that file"
fi

REASON="Extract-patterns gate (ZOU-452) — one-time session review before concluding. If this session surfaced a pattern that is ALL FOUR of: (1) specific to this project/codebase, not generic best practice; (2) likely to recur in future sessions on this repo; (3) non-obvious to a senior engineer on this codebase; (4) expressible as trigger→action — then ${ROUTE}, and append one line to /dev/shm/extract-patterns.log: '<ISO8601-UTC> session=${SID} decision=extracted domain=<domain>'. If NO pattern meets all four criteria: append '<ISO8601-UTC> session=${SID} decision=none' to that log, write NOTHING to any memory/instinct/lessons store (not even a 'checked' entry), and say only: No new patterns to extract. Do not force extraction. Then finish your original response."

jq -cn --arg r "$REASON" '{decision:"block", reason:$r}' 2>/dev/null \
  || printf '{"decision":"block","reason":"Extract-patterns gate: review session for a project-specific, recurring, non-obvious trigger→action pattern; extract it or reply No new patterns to extract."}\n'
exit 0
