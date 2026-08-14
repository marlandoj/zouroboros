# Program: rag-only-prompt-tune

## Objective
Maximize answer accuracy on the RAG-only seed-100 benchmark by tuning the answer-generation prompt template. Retrieval is fixed (rag-core, minScore=0.0). The LLM (gpt-4o-mini) and judge (gpt-4o) are also fixed. The only variable is the prompt template the answerer receives. A promotion is only valid if it also holds up on the unseen seed-hard set (see Holdout Gate) — a prompt that wins seed-100 by overfitting is vetoed, not promoted.

## Metric
- **name**: answer_accuracy_pct
- **direction**: higher_is_better
- **extract**: `grep '^METRIC=' /tmp/autoloop-rag-only.log | tail -1 | cut -d= -f2`

## Setup
```bash
# No setup required — seed and harness already in place.
true
```

## Target File
/home/workspace/zouroboros/packages/bench/data/rag-only/answer-prompt.md

## Run Command
```bash
set -o pipefail
source /root/.zo_secrets

# Step 1 — Optimized metric: answer accuracy on seed-100 (the signal the loop hill-climbs).
#          Emits METRIC= to /tmp/autoloop-rag-only.log (what the engine extracts).
# Step 2 — Holdout gate (chained with &&): re-runs the SAME candidate prompt on the unseen
#          seed-hard set and exits non-zero if seed-hard accuracy regresses below the committed
#          floor (seed-hard-floor.txt) minus HOLDOUT_TOLERANCE_PP. A non-zero exit makes the
#          engine mark the experiment CRASHED, so an overfit prompt is never promoted.
RAG_ONLY_PROMPT_FILE=/home/workspace/zouroboros/packages/bench/data/rag-only/answer-prompt.md \
RAG_ONLY_BENCH_DB=/home/workspace/zouroboros/packages/bench/data/rag-only/cache/seed-100.db \
  bun /home/workspace/zouroboros/packages/bench/adapters/rag-only-adapter.ts \
    --dataset /home/workspace/zouroboros/packages/bench/data/rag-only/seed-100.json \
    --output /home/workspace/zouroboros/packages/bench/data/runs/autoloop/ \
    --retriever rag-core 2>&1 | tee /tmp/autoloop-rag-only.log \
  && RAG_ONLY_PROMPT_FILE=/home/workspace/zouroboros/packages/bench/data/rag-only/answer-prompt.md \
       bun /home/workspace/zouroboros/packages/bench/scripts/rag-only-holdout-gate.ts
```

## Holdout Gate
Single-metric optimization on seed-100 is Goodhart-exposed: a prompt can win on seed-100 by
overfitting its 90 questions. The holdout gate (`scripts/rag-only-holdout-gate.ts`, Read-Only)
runs the candidate prompt against the **unseen seed-hard set** (30 harder paraphrased questions)
and vetoes promotion if it regresses.

- **Optimization signal**: seed-100 answer accuracy (Step 1 above).
- **Acceptance gate**: seed-hard answer accuracy must stay `>= floor - HOLDOUT_TOLERANCE_PP`.
- **Floor**: `seed-hard-floor.txt` — the baseline default-prompt seed-hard accuracy (66.67%),
  self-initialized on the first run if the file is absent. It is a fixed non-regression-vs-baseline
  guard; it does not ratchet upward.
- **Tolerance**: `HOLDOUT_TOLERANCE_PP` env, default `5.0` pp (~1.5 of the 30 questions) — absorbs
  judge noise while still catching a real multi-question overfit drop.
- **Failure path**: a gate REJECT is a non-zero Run Command exit → engine records a CRASH → the
  candidate is reverted. The reject message tells the proposer the prompt overfits seed-100 and
  must be revised to generalize.

## Read-Only Files
- adapters/rag-only-adapter.ts
- data/rag-only/seed-100.json
- data/rag-only/seed-hard.json
- data/rag-only/seed.json
- scripts/generate-seed-100.ts
- scripts/build-hard-rag-seed.ts
- scripts/rag-only-holdout-gate.ts
- data/rag-only/seed-hard-floor.txt

## Constraints
- **Time budget per run**: 5 minutes
- **Max experiments**: 30
- **Max duration**: 4 hours
- **Max cost (USD)**: 5.00

## Simplicity Criterion
The prompt should stay readable and concise. A 3-line prompt that scores +1pt is preferable to a 20-line prompt that scores +1.5pt. Reject any change that adds prompt scaffolding for marginal gains.

## Stagnation
- **Threshold**: 8 experiments with no improvement triggers radical exploration
- **Double threshold**: 16 experiments combines best past approaches
- **Triple threshold**: 24 experiments auto-stops with summary report

## Notes
- Current baseline (default prompt): 87.8% answer accuracy on seed-100.
- The prompt MUST contain literal placeholders `{context}` and `{question}` — these are substituted by the harness at runtime. Variants that drop either placeholder will error.
- Failure modes seen in baseline: the LLM hedges with "I don't know" when context paraphrases the question heavily, even when retrieval is correct. Permissive prompting that encourages semantic inference may help.
- Don't add explicit instructions about the SPECIFIC content of the seed — that's overfitting. Prompt changes must generalize, and the holdout gate enforces this mechanically: a prompt that gains on seed-100 but drops on the unseen seed-hard set (baseline floor 66.67%) is rejected by `scripts/rag-only-holdout-gate.ts` and reverted, not promoted.
- Each experiment runs 90 questions × (1 answer + 1 judge) ≈ 180 LLM calls ≈ $0.02 + ~3min wall clock.
