# @zouroboros/bench

Custom benchmarks for Zouroboros-specific capabilities that no existing memory benchmark covers.

## ZouroBench

Tests three core differentiators:

| Category | What it tests | Questions |
|---|---|---|
| **Procedural Recall** | Step recall, evolution tracking, episode linking, cross-procedure queries | 15 |
| **Cross-Persona Transfer** | Pool access, inheritance chains, access denial, multi-source aggregation | 15 |
| **Swarm Context Propagation** | Dependency context flow, artifact tracking, DAG structure, role analysis | 15 |

### Run

```bash
bun run adapters/zourobench-adapter.ts \
  --dataset data/zourobench/seed.json \
  --output data/runs/ \
  --judge \
  --judge-model gpt-4o
```

Requires `OPENAI_API_KEY` for GPT-4o judge and gpt-4o-mini answer generation. Falls back to local Ollama if unavailable.

### Model lineup roster

Consensus Gate and MoA lineup candidates are synchronized into
`data/zourobench/lineup-model-roster.json`. The roster includes current production
seats, last-good persisted seats, and approved lifecycle-promotion targets,
deduplicated by canonical model identity across BYOK, Kimi, OpenRouter, OpenCode,
and Synthetic routes.

```bash
bun /home/workspace/Skills/consensus-gate/scripts/zourobench-lineup-roster.ts --write --json
bun scripts/lineup-model-bench.ts plan --json
bun scripts/lineup-model-bench.ts run \
  --max-replicates 4 \
  --concurrency 2 \
  --provider-concurrency 1
```

Each run advances one deterministic replicate in a five-seed cohort. Qualified,
fresh proposer and aggregator cohorts become conservative ranking evidence in the
lineup picker; they do not bypass lifecycle, route health, tier, or model-family
diversity. Coder-only models remain rostered but held because the current
ZouroBench categories do not measure coding ability.

The accelerated runner schedules provider-diverse waves. It defaults to two
simultaneous cohorts and one cohort per provider, with hard caps of four globally
and two per provider. Transport retries continue to honor `Retry-After`; a failed
wave is fully settled and blocks all later waves while successful artifacts remain
available for the next resumable run. Use `--model <canonical-model-or-route>` to
retry or isolate a specific runnable cohort without editing the roster. Resume
admission requires the full evidence contract: schema v2, 45/45 answered questions,
the expected deterministic seed/index, a valid score, and complete context provenance.

### ZouroBench Code (shadow)

ZouroBench Code measures the coder role with 20 frozen TypeScript/Bun tasks across
bug fixing, feature work, integration, refactoring, and test creation. The corpus is
split into five balanced folds. Each task runs through the production Swarm
`ExecutorClient` in a disposable Bubblewrap repository; hidden tests are copied into
the repository only after the executor returns.

```bash
bun scripts/generate-zourobench-code-corpus.ts
bun scripts/zourobench-code.ts validate
bun scripts/zourobench-code.ts run \
  --executor opencode \
  --provider synthetic-new \
  --model synthetic-new/hf:zai-org/GLM-5.2 \
  --fold 1
```

Artifacts are always marked `shadow_only: true`. A coder cohort requires all five
folds, 20 unique tasks, one corpus fingerprint, Bubblewrap execution, and fresh
evidence. The standalone evidence reader is:

```bash
bun /home/workspace/Skills/consensus-gate/scripts/zourobench-code-evidence.ts --json
```

This evidence is intentionally unreachable from production lineup ranking. Promotion
requires separate calibration and an explicit governance change; reference and no-op
fixture artifacts are never eligible evidence.

### Scores (v1.0)

| Category | Score |
|---|---|
| Procedural Recall | 93–100% |
| Cross-Persona Transfer | 100% |
| Swarm Context Propagation | 100% |
| **Overall (5-run avg)** | **97.8%** |

### Seed Data

`data/zourobench/seed.json` contains 7 procedures (with versioning), 12 episodes, 28 facts across 6 personas, 3 swarm DAGs with 16 tasks, and 4 knowledge pools with inheritance chains.

## Compression Benchmark

Measures Headroom-style context compression on Zouroboros's real content and
checks whether the resulting metrics correlate with Headroom's published metric
families. Three phases, run in order:

| Phase | Script | What it does |
|---|---|---|
| 1 — capture | `scripts/compression-corpus.ts` | Samples real content from `shared-facts.db` (tool payloads, facts, episode docs, open loops) into a deterministic, length-stratified corpus. Read-only. |
| 2 — compress | `scripts/compression-benchmark.ts` | Runs two lossless compressors per item — type-aware `structural` (JSON minify / whitespace / dedup) and reversible `SmartCrusher`-analog (sentinel dictionary over repeated segments) — keeps the cheaper valid result, and records token reduction, fidelity, and latency. |
| 3 — correlate | `scripts/compression-correlation.ts` | Compresses the ZouroBench seed's own context, builds a 1:1 crosswalk to Headroom's metrics, and emits `data/compression/CORRELATION.md`. |

```bash
bun run scripts/compression-corpus.ts        # → data/compression/corpus.json
bun run scripts/compression-benchmark.ts      # → data/runs/compression-<ts>.json
bun run scripts/compression-correlation.ts    # → data/compression/CORRELATION.md
```

No API keys required — token counts use the runtime's own `chars/4` budget
estimator and all compression is lossless (fidelity 1.000), so ZouroBench
accuracy is provably unchanged.

### Results (v1.0)

| Corpus | Token reduction | Fidelity | Notes |
|---|---|---|---|
| Production (160 real items) | **−13.1%** | 1.000 | Heaviest types compress most: episode key-dumps −15%, open loops −14%. |
| ZouroBench seed (64 items) | −0.2% | 1.000 | Hand-authored seed is near-incompressible — real traffic carries the redundancy. |

Verbosity↔reduction Pearson r ≈ **0.74**: more redundant content compresses
more, matching Headroom's framing.
