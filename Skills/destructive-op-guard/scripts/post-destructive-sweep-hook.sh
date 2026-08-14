#!/usr/bin/env bash
# PostToolUse advisory hook (matcher: Bash). Fail-open, never blocks, always exit 0.
#
# When a Bash command matches a teardown/destructive pattern, emit an
# additionalContext reminder to run a same-turn workspace reference sweep for the
# removed identifier (sweep-refs.sh) before declaring "no orphaned resources".
# Closes the gap where DIRECT (non-swarm) destructive ops route through zero gates.
set +e

raw="$(cat 2>/dev/null)"
[ -z "$raw" ] && exit 0

# Fast pre-filter on the raw payload before spawning jq — the common (benign) case
# exits here in microseconds, so this hook is cheap on every single Bash call.
printf '%s' "$raw" | grep -Eiq 'delete|destroy|drop|--force|[^a-z]rm ' || exit 0

cmd="$(printf '%s' "$raw" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# Genuinely destructive / hard-to-reverse actions on shared infra or data.
if printf '%s' "$cmd" | grep -Eiq \
  '(hcloud[[:space:]]+[a-z-]+[[:space:]]+delete)|(\brm[[:space:]]+-[a-zA-Z]*[rf])|(git[[:space:]]+push[[:space:]].*(--force|-f\b))|(terraform[[:space:]]+destroy)|(DROP[[:space:]]+(TABLE|DATABASE|SCHEMA))|(\bdropdb\b)|(delete_user_service)'; then
  MSG='[destructive-op advisory] The Bash command just executed matches a teardown/destructive pattern. If it removed a NAMED resource (cloud box, service, IP, DB table, branch), run a same-turn workspace reference sweep BEFORE declaring "no orphaned resources": bash /home/workspace/Skills/destructive-op-guard/scripts/sweep-refs.sh <identifier> [<identifier2> ...] — live-config/code hits = review or fix; log/doc/reprovision-source hits = leave. "No orphaned resources" must cover workspace references, not just the provider side.'
  jq -cn --arg m "$MSG" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}' 2>/dev/null
fi
exit 0
