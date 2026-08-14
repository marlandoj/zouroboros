# Consensus Gate — Zouroboros Integration

## Status: Phase 1 LIVE (2026-05-09)

The consensus gate is **active in production**. It validates every procedure evolution in the Zouroboros memory pipeline before committing to `shared-facts.db`.

---

## Architecture

```
evolveProcedure() or draftCandidate()
    ↓
execSync("consensus-gate.ts validate ...")
    ↓
Parallel fan-out to 3 models on synthetic.new
    ↓
Merged verdict → JSON on stdout
    ↓
  ✅ Unanimous  pass  → Save immediately
  ⚠️ Split       verdict → Log warning, proceed (graceful degradation)
  ❌ Unanimous   fail   → Reject + throw with issue list
```

---

## Model Lineup (synthetic.new)

| Vendor | Model | Role | Why |
|---|---|---|---|
| Zhipu | `hf:zai-org/GLM-5.2` | Coherence + implementation quality | Frontier reasoning, excels at code structure |
| Moonshot | `hf:moonshotai/Kimi-K2.6` | Edge cases + security + perf | Deep context window, thorough analysis |
| MiniMax | `hf:MiniMaxAI/MiniMax-M3` | Architectural consistency + cross-concerns | Balanced reasoning, good JSON compliance |

**Fallback:** If `SYNTHETIC_NEW_API_KEY` is missing, models fall through to Zo `/zo/ask` proxy. This degrades to the prior Claude/GPT/Gemini lineup.

---

## Provider Failover (OpenRouter → Opencode Zen)

synthetic.new is the **primary** provider. When it returns an empty or errored
verdict for a model (vendor-side degradation — empty body, `API error:`, or
`Call failed:`), the gate transparently **fails over to the same model**, first on
**OpenRouter**, then on **Opencode Zen**, using the first good verdict. synthetic.new
stays primary; the failovers only fire on failure, so vendor outages no longer
poison the consensus.

```
callVendor(model, prompt)
    ↓
synthetic.new  (primary)
    ↓ verdict empty / errored?  ──no──→  use it
    ↓ yes
OpenRouter  (same model, ID-mapped)
    ↓ verdict empty / errored?  ──no──→  use it
    ↓ yes
Opencode Zen  (same model, ID-mapped)
    ↓ verdict empty / errored?  ──no──→  use it
    ↓ yes
return synthetic's original verdict (preserve error context)
```

**Model ID mapping** — `hf:org/Model` (synthetic) → `org/model` slug (OpenRouter),
lowercased, with org aliases (`zai-org`→`z-ai`, `minimaxai`→`minimax`). Example:
`hf:zai-org/GLM-5.2` → `z-ai/glm-5.2`. Opencode Zen uses bare, org-less lowercase
slugs: `hf:zai-org/GLM-5.2` → `oc:glm-5.2` (the `oc:` prefix is stripped in the
request body). The `xai:` (grok) rung routes to x.ai directly and has no OpenRouter
or Opencode equivalent, so it does not fail over.

| Env var | Default | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required for OpenRouter failover; if absent, that hop is skipped |
| `CG_OPENROUTER_FAILOVER` | on | Set to `"0"` to disable the OpenRouter hop |
| `OPENCODE_API_KEY` | — | Required for Opencode Zen failover; if absent, that hop is skipped |
| `CG_OPENCODE_FAILOVER` | on | Set to `"0"` to disable the Opencode hop (e.g. balance exhausted) |

**Sole-provider order** — with no `SYNTHETIC_NEW_API_KEY`, the gate uses OpenRouter
as the sole provider; with neither synthetic nor OpenRouter keys, it uses Opencode
Zen as the sole provider. When all vendor keys are absent, the gate still falls
through to the Zo `/zo/ask` proxy as before.

**Billed cost** — OpenRouter (`usage.cost`, requested with `usage:{include:true}`)
and Opencode Zen (top-level `cost`) both return a real per-call cost. The gate
records that figure verbatim in `cost_ledger` (`rate_source=<provider>-billed`,
`estimated=0`) rather than a token estimate.

---

## Phase 1: Procedure Evolution (ACTIVE)

**Location:** `zouroboros/packages/memory/src/standalone/memory.ts` → `evolveProcedure()` (line ~1103)

**Behavior:** After the LLM generates a new procedure step but before saving to `shared-facts.db`, exec the consensus gate. Unanimous failure blocks the evolution with a descriptive error. Split verdicts log a warning but proceed (soft gate — avoids deadlock on model disagreement).

```typescript
const consensusGatePath = "/home/workspace/Skills/consensus-gate/scripts/consensus-gate.ts";
const stepCode = JSON.stringify(validSteps, null, 2);

const validationOutput = execSync(
  `bun "${consensusGatePath}" validate --code ${JSON.stringify(stepCode)} --criteria "correctness,consistency,security" --label "procedure-${procedureName}-v${current.version + 1}"`,
  { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
);

const validationResult = JSON.parse(validationOutput);

if (validationResult.consensus.pass === false) {
  const issues = validationResult.verdicts
    .flatMap((v: any) => v.issues || [])
    .join("; ");
  throw new Error(
    `Consensus gate rejected evolved procedure: ${issues || "multiple concerns from vendors"}`
  );
}

if (validationResult.consensus.pass === null) {
  console.warn(`⚠️ Split verdict on procedure evolution: ${validationResult.status}`);
  console.warn(`   Disagreement details logged to consensus-gate.log`);
  console.warn(`   Procedure ID for audit: ${validationResult.id}`);
}
```

**Key design decisions:**
- **`proc.stdout.write`** used internally (not `console.log`) so `execSync` receives clean JSON
- **`try/catch` wrapper** around entire gate block: `ENOENT` (script missing), script crashes, or API timeout → warn + proceed (gate is a safety layer, not a hard blocker)
- **Unanimous-fail-only rejection** — split verdicts log but don't block. This avoids deadlock where GLM-5.2 is cautious and MiniMax is permissive. Future Phase 2 may add Mimir escalation for splits.

---

## Phase 2: Skill Crystallization (PLANNED)

**Where:** `zouroboros/packages/selfheal/src/crystallize/orchestrate.ts` → `orchestrateScan()` (before sending approval email)

Not yet wired. Will validate the SKILL.md body + generated scripts before emailing approval. Split verdicts will add a ⚠️ note to the email body. Unanimous rejections will reject the candidate immediately.

---

## Phase 3: Pre-merge CI Gate (PLANNED)

**Where:** GitHub Actions workflow `.github/workflows/ci.yml`

Not yet wired. Concept: run consensus gate on PR diff, fail CI on unanimous rejection.

---

## Logging & Audit

### Database
All raw results: `~/.zouroboros/consensus-gate.json` (JSON array)

### Append-only log
`~/.zouroboros/consensus-gate.log` — JSON Lines:

```json
{
  "timestamp": "2026-05-07T23:40:00Z",
  "consensus_id": "cg-1778197717312-7ox03j",
  "label": "procedure-xyz-step-4",
  "status": "split",
  "api": "synthetic.new",
  "verdict": {
    "pass": null,
    "confidence": 0.83,
    "models": {
      "hf:zai-org/GLM-5.2": { "pass": true, "issues": [] },
      "hf:moonshotai/Kimi-K2.6": { "pass": true, "issues": [] },
      "hf:MiniMaxAI/MiniMax-M3": { "pass": false, "issues": ["missing null-check"] }
    }
  }
}
```

Query recent unanimous rejections:
```bash
grep '"status":"rejected"' ~/.zouroboros/consensus-gate.log | tail -10
```

Query split verdicts:
```bash
grep '"status":"split"' ~/.zouroboros/consensus-gate.log | tail -5
```

---

## Runtime Fidelity Check

Run this anytime to verify the gate works end-to-end:

```bash
cd /home/workspace/Skills/consensus-gate
bun scripts/consensus-gate.ts validate \
  --code "function risky(a) { eval(a); }" \
  --criteria "security,correctness" \
  --label "integration-test"
```

Expected: **REJECTED** with issues like "unsafe eval usage".

---

## Cost & Latency

| Metric | Value | Notes |
|---|---|---|
| Per validation | $0 (keyed) | SYNTHETIC_NEW_API_KEY covers usage |
| Failover spend | Provider-billed | Only when synthetic degrades and an OpenRouter/Opencode hop serves the call; real `cost` recorded to `cost_ledger` |
| Fallback latency | 15–45s | Zo `/zo/ask` proxy path |
| Direct latency | 6–12s | Synthetic.new parallel calls |
| Cadence | On every procedure evolution | Every zouroboros auto-shard triggers ~1 gate |
| p50 daily cost | $0 | No ephemeral per-call charges on the primary path |

---

## Known Model Quirks

| Model | Quirk | Mitigation |
|---|---|---|
| GLM-5.2 | Returns output in `reasoning_content`, not `content` | Script checks both fields |
| Kimi-K2.6 | Occasionally verbose even with `temperature: 0.2` | JSON regex extraction handles fences |
| MiniMax-M3 | Non-deterministic on trivial code (sometimes over-analyzes `x*2`) | Split verdict is soft, not blocking |

---

## Future Work

1. **Mimir escalation** for split verdicts. Currently splits are logged but not synthesized.
2. **Skill crystallization gate** (Phase 2) — validate `SKILL.md` body before approval.
3. **CI gate** (Phase 3) — run on PR diffs.
4. **Retry with fewer models** if synthetic.new is rate-limiting (429).

---

## Related Skills

- `Skills/consensus-gate/SKILL.md` — full skill documentation
- `Skills/consensus-gate/scripts/consensus-gate.ts` — runnable implementation
- `agent-doctor` — diagnose scheduled agents
- Three-stage-eval — pre-swarm validation
