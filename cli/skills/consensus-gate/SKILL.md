---
name: consensus-gate
description: |
  Multi-vendor validation gate with direct synthetic.new integration. Routes code
  and logic through three frontier models (GLM-5.1, Kimi-K2.6, Grok-3-Mini)
  in parallel; flags disagreement before merge or evolution. Currently active in
  production as the Phase 1 gate for zouroboros procedure evolution.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: 2.4.0
  last_updated: 2026-06-18
  api: synthetic.new (primary) | openrouter (same-model failover) | x.ai (direct, xai: models) | zo-proxy (degrade)
  models:
    - hf:zai-org/GLM-5.1
    - hf:moonshotai/Kimi-K2.6
    - xai:grok-3-mini
---

# Consensus Gate

**Multi-vendor code validation** — currently live in zouroboros procedure evolution. Before any evolved procedure step commits to `shared-facts.db`, three frontier models review it in parallel. Unanimous failure blocks the commit.

**v2.1 changes:** diff-scoped prompts, structured objection classification (PATCH_SPECIFIC / PRE_EXISTING / OUT_OF_SCOPE), VENDOR_ERROR bucket excluded from signal/noise math, and `noise-stats` for tracking signal-vs-noise over time. Backward-compatible — `verdicts[].issues` still emits formatted strings.

---

## Quick start

```bash
cd /home/workspace/Skills/consensus-gate

# Validate full file/snippet
bun scripts/consensus-gate.ts validate \
  --code "function addUser(name, email) { ... }" \
  --criteria "security,correctness,perf" \
  --label "new-user-step"

# Validate a diff (auto-detected from `diff --git` / `@@` markers)
bun scripts/consensus-gate.ts validate \
  --file /tmp/patch.diff \
  --label "PR #123: ledger fix"

# Force scope explicitly
bun scripts/consensus-gate.ts validate --file foo.ts --scope full --label "foo"
bun scripts/consensus-gate.ts validate --file bar.diff --scope diff --label "bar"

# Noise/signal report (last 7 days)
bun scripts/consensus-gate.ts noise-stats --since 7

# Custom model trio
bun scripts/consensus-gate.ts validate \
  --models "hf:zai-org/GLM-5.1,hf:moonshotai/Kimi-K2.6,hf:deepseek-ai/DeepSeek-V3.2" \
  --code "..." --criteria "security"

# Retrieve a result
bun scripts/consensus-gate.ts result cg-1778362278914-x16fxm

# List recent validations
bun scripts/consensus-gate.ts list --limit 10
```

---

## How it works

1. **Input** — code (or diff) to validate + criteria (e.g., `correctness,security`)
2. **Scope selection** — `--scope auto|diff|full` (default `auto`). Auto-detects unified-diff hunk markers (`diff --git`, `@@ -.. +.. @@`) or the `=== DIFF ===` header used by `pre-merge-gate`. In `diff` mode the prompt instructs reviewers to ignore unchanged context and to mark any pre-existing concern as `PRE_EXISTING`.
3. **Parallel fan-out** — three models fire simultaneously to `api.synthetic.new/openai/v1/chat/completions`
4. **Collect verdicts** — each returns `{ pass, objections[], confidence }` (see schema below). Legacy `{ issues: [string] }` responses still parse.
5. **Per-verdict effective pass** — a verdict is `pass: false` ONLY if at least one objection is `PATCH_SPECIFIC` AND `severity: blocker`. Verdicts that returned `pass: false` but contained only `PRE_EXISTING` / `OUT_OF_SCOPE` objections are *overridden* to PASS and tagged `overridden: true`.
6. **Consensus rule** (computed from effective pass):
   - **All pass** → ✅ `passed`, proceed
   - **All fail** → ❌ `rejected`, reject with merged issue list
   - **Mix** → ⚠️ `split`, log, proceed (soft gate)
7. **Output** — JSON result to stdout. Each verdict carries both the structured `objections` array and the backward-compat `issues: string[]` (formatted as `"[scope/severity] text"`).

---

## Architecture & diagrams

![Consensus Gate — synthetic.new primary with OpenRouter failover](assets/consensus-gate-failover.png)

*synthetic.new is **primary**; on an empty or errored verdict the gate fails over to the **same model on OpenRouter** (IDs auto-mapped, e.g. `hf:zai-org/GLM-5.1` → `z-ai/glm-5.1`). `grok-3-mini` routes to x.ai directly and does not fail over. Gated by `CG_OPENROUTER_FAILOVER` (default on).*

**Diagram locations:**

| Diagram | Location |
|---|---|
| Provider-failover infographic (PNG) | `assets/consensus-gate-failover.png` |
| Infographic source (editable HTML) | `assets/consensus-gate-failover.html` |
| Pipeline + failover ladder (ASCII) | [`INTEGRATION.md`](INTEGRATION.md) → *Architecture* and *Provider Failover (OpenRouter)* |

---

## Model lineup

| Role | Model | Source | Quirk |
|---|---|---|---|
| Coherence + impl quality | `hf:zai-org/GLM-5.1` | Zhipu/API | Outputs in `reasoning_content` |
| Edge cases + security | `hf:moonshotai/Kimi-K2.6` | Moonshot | Deep context, thorough |
| Architectural consistency | `xai:grok-3-mini` | x.ai | Prefers `XAI_API_KEY` for direct x.ai routing; falls back to chain via active LLM provider |

**Provider credentials:**
1. **`SYNTHETIC_NEW_API_KEY`** *(primary)* — full `hf:` model routing with fallback chains. Set in [Settings > Advanced](/?t=settings&s=advanced).
2. **`OPENROUTER_API_KEY`** *(failover)* — when synthetic.new returns an empty/errored verdict, the gate fails over to the **same model** on OpenRouter (`hf:` IDs are auto-mapped to OpenRouter slugs, e.g. `hf:zai-org/GLM-5.1` → `z-ai/glm-5.1`). Gated by `CG_OPENROUTER_FAILOVER` (default on; set `0` to disable). If `SYNTHETIC_NEW_API_KEY` is absent entirely, OpenRouter becomes the sole provider.
3. **`ZO_TOKEN`** *(soft degrade)* — proxies all three calls through `/zo/ask`; vendor diversity is lost (same model votes 3×).
4. **None** — mock mode (CI only, not production-safe).

---

## Integration: zouroboros (LIVE)

Wired at `zouroboros/packages/memory/src/standalone/memory.ts:1103` in `evolveProcedure()`:

```typescript
const stepCode = JSON.stringify(validSteps, null, 2);
const validationOutput = execSync(
  `bun "${consensusGatePath}" validate --code ${JSON.stringify(stepCode)} --criteria "correctness,consistency,security" --label "procedure-${procedureName}-v${current.version + 1}"`,
  { encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }
);
const validationResult = JSON.parse(validationOutput);

if (validationResult.consensus.pass === false) {
  const issues = validationResult.verdicts
    .flatMap((v: any) => v.issues || [])
    .join("; ");
  throw new Error(`Consensus gate rejected: ${issues}`);
}
```

The gate is wrapped in `try/catch` — script failure (missing, crash, API timeout) logs a warning and proceeds. This ensures zouroboros never hard-blocks on a gate outage.

---

## Output schema

```typescript
{
  id: string;                    // cg-{timestamp}-{random}
  timestamp: string;             // ISO 8601
  label: string;                 // "procedure-x-v3"
  code: string;                  // original input
  criteria: string;              // "correctness,security"
  verdicts: [{
    model: string;               // "hf:zai-org/GLM-5.1"
    pass: boolean;               // EFFECTIVE pass (post noise-suppression)
    modelPass: boolean;          // raw verdict from model
    overridden: boolean;         // true if effective != modelPass
    issues: string[];            // ["[PATCH_SPECIFIC/blocker] missing null-check"]
    objections: [{
      text: string;
      scope: "PATCH_SPECIFIC" | "PRE_EXISTING" | "OUT_OF_SCOPE"
           | "UNCLASSIFIED" | "VENDOR_ERROR";
      severity: "blocker" | "warning" | "info";
    }],
    confidence: number;          // 0.0–1.0 (vendor errors = 0)
    latencyMs: number;           // 4500
    api: "synthetic.new" | "zo-proxy";
  }],
  consensus: {
    unanimous: boolean;
    pass: boolean | null;        // true / false / null (split)
    confidence: number;
  },
  metrics: {
    scope: "diff" | "full";
    detected_diff: boolean;
    total_objections: number;    // includes vendor_errors
    classified_objections: number; // total - vendor_errors; denominator for ratios
    patch_specific: number;
    pre_existing: number;
    out_of_scope: number;
    unclassified: number;        // legacy responses (no scope field)
    vendor_errors: number;       // HTTP/timeout/parse failures — infra, not quality
    blockers_patch_specific: number;
    signal_ratio: number;        // patch_specific / classified_objections
    noise_ratio: number;         // (pre_existing + out_of_scope) / classified_objections
    overrides: number;           // verdicts where effective != modelPass
    would_have_failed: boolean;  // would consensus have rejected without override?
  },
  status: "passed" | "rejected" | "split"
}
```

### Reviewer prompt schema (model output)

```json
{
  "pass": true,
  "objections": [
    {
      "text": "missing null-check on user.email before lookup",
      "scope": "PATCH_SPECIFIC",
      "severity": "blocker"
    }
  ],
  "confidence": 0.85
}
```

`scope` is REQUIRED on every objection. `pass: false` is reserved for blocking PATCH_SPECIFIC objections; PRE_EXISTING and OUT_OF_SCOPE concerns are surfaced but do not block.

**VENDOR_ERROR** is reserved for the gate itself — emitted when a model call returns HTTP error, times out, or returns unparseable JSON. It is excluded from `signal_ratio` and `noise_ratio` denominators so a provider outage cannot trip the noise alarm. Models should never emit `VENDOR_ERROR` themselves; any model-emitted occurrence is silently downgraded to `UNCLASSIFIED`.

---

## Logging

**Database:** `~/.zouroboros/consensus-gate.json` (JSON array, all results — includes structured `metrics`)

**Log:** `~/.zouroboros/consensus-gate.log` (JSON Lines, append-only — includes per-run `metrics.signal_ratio`, `noise_ratio`, `overrides`, `would_have_failed`)

Query from bash:
```bash
grep '"status":"rejected"' ~/.zouroboros/consensus-gate.log | tail -5
```

## Monitoring noise vs signal

```bash
bun scripts/consensus-gate.ts noise-stats --since 7
```

Reports:
- `signal_ratio` (PATCH_SPECIFIC / classified objections) and `noise_ratio` ((PRE_EXISTING + OUT_OF_SCOPE) / classified objections) over the window. Classified = total minus VENDOR_ERROR, so a provider outage cannot move the needle.
- `vendor_error_rate` — fraction of verdicts that failed for infrastructure reasons (HTTP, timeout, parse). Watch separately; this is a vendor-health signal, not a gate-quality signal.
- `override_rate` — fraction of verdicts where the noise-suppression rule flipped a model's `pass: false` to PASS
- `would_have_failed_rate` — fraction of runs that would have been REJECTED if we trusted raw model `pass` instead of the effective rule
- Top-5 noisiest and top-5 highest-signal labels (n≥3 classified objections)
- Trend: noise ratio in the recent half of the window vs the prior half

If noise climbs (e.g. noise_ratio > 45% sustained, or `would_have_failed_rate` > 20%) the gate is generating more friction than value — that's the signal to wire deferred item #3 (scope precheck + 2-round cap for refactors).

### Automated noise watch

```bash
bun scripts/noise-watch.ts --since 7
```

Computes `HEALTHY` / `WARN` / `CRITICAL` / `DATA_GAP` from the noise-stats payload and emits a one-line verdict. Default thresholds: WARN at noise≥45% or would-fail≥20%, CRITICAL at noise≥65% or would-fail≥40%. Exit codes: `0` healthy, `1` data gap, `2` warn, `3` critical — usable as the `command` of a scheduled agent that pages on regression.

To wire as a weekly Zo agent (suggested, not auto-created):
```
schedule: weekly Mon 09:00 America/Phoenix
command: source /root/.zo_secrets && bun /home/workspace/Skills/consensus-gate/scripts/noise-watch.ts --since 7
delivery: email if exit ≥ 2
```

---

## Cost

| Path | Cost |
|---|---|
| Synthetic.new direct (default) | $0 (credited key) |
| Zo `/zo/ask` fallback | Consumes Zo credits |

Direct path is preferred: lower latency, no credit burn.

---

## Failure modes

| Scenario | Behavior |
|---|---|
| API 429 / 500 | Individual model FAILs with "HTTP 429", consensus computed from remaining |
| `SYNTHETIC_NEW_API_KEY` missing | Falls back to Zo `/zo/ask` proxy (if `ZO_TOKEN` available) |
| Missing script (`ENOENT`) | Warn + skip, no block |
| Model returns empty | Verdict `pass: false`, `issues: ["Empty response"]` |
| Model returns malformed JSON | Verdict `pass: false`, `issues: ["JSON parse failed: ..."]` |
| All 3 models fail | Consensus = `rejected` (unanimous failure to validate) |

---

## Related

- `INTEGRATION.md` — zouroboros wiring details
- `agent-doctor` — diagnose scheduled agents
- Three-stage-eval — pre-execute swarm validation
