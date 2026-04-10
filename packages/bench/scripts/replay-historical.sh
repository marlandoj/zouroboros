#!/bin/bash
# Replay 25 real historical user messages through the swarm decision gate
# Ground truth labeled from activity profile + conversation memory

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$SCRIPT_DIR/../../swarm/src/routing/swarm-decision-gate.ts"

declare -a MESSAGES=(
  "Perform deep research on https://github.com/affaan-m/everything-claude-code and evaluate which concepts would benefit the Zouroboros ecosystem. Use swarm orchestration to digest the repo and perform evaluations. Send final report via email including pdf document."
  "Resolve and merge PR#38"
  "What time is it in Phoenix?"
  "Run a simple swarm-bench to validate the memory system accuracy"
  "Create a blog post about reducing tool call failures"
  "Fix the TypeScript error in packages/swarm/src/db/schema.ts"
  "Implement the PKA session briefing feature with proactive knowledge synthesis, domain tagging, cross-persona promotion, and memory-gate Tier 0 skip"
  "Check my email"
  "Send me a summary of today's trading bot performance via email with PDF"
  "Update the README for the monorepo"
  "Research MAGMA, MemEvolve, and Supermemory - compare with zo-memory"
  "Deploy the risk dashboard with 9 components and 21 tests"
  "Generate an image of a zen garden with Fauna Flora branding"
  "What's the Sharpe ratio for the stochastic RSI strategy?"
  "Implement ACP integration with ExecutorTransport abstraction, BridgeTransport, ACPTransport for Claude Code/Codex/Gemini"
  "Set up the Discord bot with bridge architecture"
  "Run tsc --noEmit on the swarm package"
  "How has the swarm orchestrator changed now that today's changes have been implemented?"
  "Publish all packages to npm - run the release pipeline"
  "Create a zo.space dashboard showing usage metrics with 9 API routes and 2 pages"
  "Fix the bot-engine Sharpe ratio calculation bug"
  "Write a PR to add the agent-model-healer skill to the community registry"
  "Migrate the memory system from Ollama to gpt-4o-mini with model-client.ts abstraction"
  "Perform a full three-stage evaluation on the swarm phase 2 implementation"
  "Tell Kevin I'll be 10 minutes late"
)

# Ground truth: DIRECT, SUGGEST, SWARM, FORCE_SWARM
declare -a EXPECTED=(
  "FORCE_SWARM"  # explicit "use swarm orchestration"
  "DIRECT"       # single merge action
  "DIRECT"       # trivial question
  "DIRECT"       # single bench run
  "DIRECT"       # blog creation — single deliverable, pipeline is internal
  "DIRECT"       # single file fix
  "SUGGEST"      # multi-feature but one implementation — sub-features aren't independent
  "DIRECT"       # simple lookup
  "DIRECT"       # linear pipeline: gather → format → send
  "DIRECT"       # single file edit
  "SUGGEST"      # research with comparison, but no implementation
  "SWARM"        # multi-component deploy + tests + verification
  "DIRECT"       # single image generation
  "DIRECT"       # single metric lookup
  "SWARM"        # 3 transport implementations, tests, multi-package
  "DIRECT"       # single task with architecture decision
  "DIRECT"       # single command
  "DIRECT"       # explanation request
  "SUGGEST"      # multi-step pipeline but formulaic
  "SWARM"        # 11 routes, dashboard design, API + pages
  "DIRECT"       # single bug fix
  "DIRECT"       # PR is a single focused deliverable
  "SUGGEST"      # migration is multi-step but linear, not parallel
  "DIRECT"       # eval is structured but single-purpose
  "DIRECT"       # single SMS
)

PASS=0
FAIL=0
TOTAL=${#MESSAGES[@]}

echo "=== Swarm Decision Gate — Historical Replay ==="
echo "Corpus: $TOTAL real user messages from activity history"
echo ""
printf "%-4s %-12s %-12s %-6s %s\n" "#" "Expected" "Got" "Score" "Message (truncated)"
echo "------------------------------------------------------------------------------------"

for i in "${!MESSAGES[@]}"; do
  MSG="${MESSAGES[$i]}"
  EXP="${EXPECTED[$i]}"
  
  # Write message to temp file to avoid shell escaping issues
  echo "$MSG" > /tmp/gate-msg.txt
  
  OUTPUT=$(bun "$GATE" --json "$(cat /tmp/gate-msg.txt)" 2>/dev/null)
  DECISION=$(echo "$OUTPUT" | jq -r '.decision // empty')
  SCORE=$(echo "$OUTPUT" | jq -r '.score // empty')
  
  TRUNC="${MSG:0:60}"
  
  if [ "$DECISION" = "$EXP" ]; then
    STATUS="✓"
    ((PASS++))
  else
    STATUS="✗"
    ((FAIL++))
  fi
  
  printf "%-4s %-12s %-12s %-6s %s %s\n" "$((i+1))" "$EXP" "$DECISION" "$SCORE" "$STATUS" "$TRUNC"
done

echo ""
echo "=== Results ==="
ACCURACY=$(echo "scale=1; $PASS * 100 / $TOTAL" | bc)
echo "Pass: $PASS / $TOTAL ($ACCURACY%)"
echo "Fail: $FAIL"
[ "$FAIL" -eq 0 ] && echo "STATUS: ALL PASS" || echo "STATUS: REVIEW NEEDED"
