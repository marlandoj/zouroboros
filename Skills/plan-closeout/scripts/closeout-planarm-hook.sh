#!/usr/bin/env bash
# Claude Code PostToolUse hook (matcher: ExitPlanMode) — arms plan-closeout.
#
# When a plan is approved and execution begins, write the PLAN_ACTIVE sentinel so
# the Stop hook requires a passing closeout before the session can conclude. This
# makes the formal-plan path mechanically enforced rather than memory-dependent.
# Fails open: if anything goes wrong the turn proceeds normally.
set -u

INPUT=$(cat)

# Derive a short label from the plan's first heading/line.
PLAN=$(printf '%s' "$INPUT" | jq -r '.tool_input.plan // empty' 2>/dev/null)
LABEL=$(printf '%s' "$PLAN" | grep -m1 . | sed 's/^[#*[:space:]-]*//' | cut -c1-120)
[[ -z "$LABEL" ]] && LABEL="plan approved $(date -u +%FT%TZ)"

python3 /home/workspace/Skills/plan-closeout/scripts/closeout.py --arm "$LABEL" >/dev/null 2>&1 || true
exit 0
