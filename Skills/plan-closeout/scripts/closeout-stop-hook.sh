#!/usr/bin/env bash
# Claude Code Stop hook — refuses to conclude while a plan-closeout is armed.
#
# A plan is "armed" when /home/workspace/.closeout/PLAN_ACTIVE exists (set by
# `closeout.py --arm` or the ExitPlanMode hook). closeout.py removes it only
# after a run whose deterministic eval gate passed. So this hook converts the
# soft "remember to run the Definition of Done" rule into a mechanical gate.
#
# Reads the Stop-hook JSON on stdin; emits {"decision":"block","reason":...} to
# force a continuation, else exits 0. The stop_hook_active guard makes it nudge
# once rather than trap a session in a loop. Fails open on any error.
set -u

SENTINEL="/home/workspace/.closeout/PLAN_ACTIVE"

# Nothing armed → let the turn end. (Common case; skip reading stdin.)
[[ -f "$SENTINEL" ]] || exit 0

INPUT=$(cat)
ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)

# Already blocked once this stop cycle → don't trap the session; allow exit.
if [[ "$ACTIVE" == "true" ]]; then
  printf 'plan-closeout: PLAN_ACTIVE still set; allowing stop to avoid a loop. Run closeout.py to clear it.\n' >&2
  exit 0
fi

LABEL=$(jq -r '.label // "the active plan"' "$SENTINEL" 2>/dev/null)
[[ -z "$LABEL" || "$LABEL" == "null" ]] && LABEL="the active plan"

REASON="A plan is still armed for closeout (\"${LABEL}\"). Before concluding, run the Definition of Done: python3 Skills/plan-closeout/scripts/closeout.py --file <changed files> --eval \"<deterministic check>\". A passing run clears the gate. To abandon the plan without closing out, run: python3 Skills/plan-closeout/scripts/closeout.py --disarm"

jq -cn --arg r "$REASON" '{decision:"block", reason:$r}' 2>/dev/null \
  || printf '{"decision":"block","reason":"A plan is armed for closeout — run Skills/plan-closeout/scripts/closeout.py before concluding (or --disarm to abandon)."}\n'
exit 0
