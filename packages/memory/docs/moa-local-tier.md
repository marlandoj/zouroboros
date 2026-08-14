# Local Inference Tier — 4th MoA Proposer (ZOU-421)

A self-hosted model inference tier served by **vLLM** or **SGLang** on the Hetzner
GPU compute annex, registered as a **4th proposer** in the Mixture-of-Agents (MoA)
lineup alongside the three vendor proposers (GLM-5.2, Kimi-K2.6, DeepSeek-V4 via
OpenRouter).

This closes the **vendor-agnostic generation socket**: if a vendor deprecates or
reprices a model, the local tier is a one-env-var fallback. It also enables
**same-base-model vendor-vs-self-hosted A/B** to isolate API-call overhead
(latency, cost) from model quality.

> **Scope note.** This is a *remote* self-hosted endpoint reached over HTTP
> (`ZO_VLLM_BASE_URL`), **not** the on-host Ollama paths removed 2026-05-29
> (the Zo host has no GPU). The model runs on the Hetzner annex (ZOU-414).

---

## 1. Arming the local tier

The tier is **dormant by default** — armed only when `ZO_VLLM_BASE_URL` is set.
When unset, the MoA lineup is byte-identical to the 3-vendor default (no behavior
change, no extra latency, no extra cost). This mirrors the existing `moa` provider
dormancy contract.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ZO_VLLM_BASE_URL` | **yes (to arm)** | — | vLLM/SGLang OpenAI-compatible base, e.g. `http://hetzner-gpu:8000/v1` |
| `ZO_VLLM_MODEL` | no | `deepseek-v4` | served model id |
| `ZO_VLLM_API_KEY` | no | — | optional bearer (vLLM accepts a dummy key) |
| `ZO_VLLM_USD_PER_1K` | no | `0` | amortized self-host cost per 1K tokens (for honest cost accounting) |

```bash
export ZO_VLLM_BASE_URL=http://hetzner-gpu:8000/v1
export ZO_VLLM_MODEL=deepseek-v4
# optional: export ZO_VLLM_API_KEY=••• ; export ZO_VLLM_USD_PER_1K=0.0002
```

When armed, the MoA lineup becomes 4 proposers; the local proposer's failure is
isolated by `Promise.allSettled` (graceful degradation — same contract as a
vendor 5xx: one down proposer never breaks the synthesis).

## 2. The MoA lineup

| # | Proposer | Kind | Endpoint |
|---|---|---|---|
| 1 | `z-ai/glm-5.2` | vendor | OpenRouter |
| 2 | `moonshotai/kimi-k2.6` | vendor | OpenRouter |
| 3 | `deepseek/deepseek-v4-pro` | vendor | OpenRouter |
| 4 | `local/<ZO_VLLM_MODEL>` | **local** | `ZO_VLLM_BASE_URL` (when armed) |

The aggregator stays vendor (GLM-5.2 via OpenRouter); the local tier is a
**proposer**, not an aggregator.

## 3. Cost accounting

Vendor tokens are billed at `MOA_USD_PER_1K_TOKENS` (≈ blended OpenRouter rate).
Local tokens are billed at `ZO_VLLM_USD_PER_1K` (default `0` = free-at-API; set it
to the amortized Hetzner cost per 1K tokens for honest bookkeeping). The two are
summed honestly in `GenerateResult.cost_usd`; the default (unarmed) cost is
byte-identical to the pre-ZOU-421 path.

## 4. Public API (model-client.ts)

```ts
export type ProposerKind = "vendor" | "local";
export interface Proposer { slug; kind; model; baseURL?; token?; }
export function getMoaProposers(): Proposer[];          // active lineup (3 or 4)
export function localTierArmed(): boolean;              // ZO_VLLM_BASE_URL set?
export async function proposerChat(p, system, prompt, maxTokens, temp); // production dispatch
export async function localChat(p, system, prompt, maxTokens, temp);    // local endpoint only
export async function localInferenceHealthCheck(): Promise<HealthResult>; // GET <base>/models
```

## 5. A/B comparison harness

`packages/memory/src/standalone/moa-local-ab.ts` runs the SAME base model through
the vendor path (OpenRouter) and the self-hosted path (vLLM/SGLang) over a
**12-instance SWE-bench-style set**, then compares.

```bash
# Dry-run (default when ZO_VLLM_BASE_URL is unset): deterministic mock, zero spend.
# Proves the pipeline: load → dual dispatch → metrics → report.
bun packages/memory/src/standalone/moa-local-ab.ts --dry-run

# Live (requires ZO_VLLM_BASE_URL + OPENROUTER_API_KEY): real calls to both endpoints.
bun packages/memory/src/standalone/moa-local-ab.ts --live \
  --base deepseek-v4 --vendor-slug deepseek/deepseek-v4-pro --local-model deepseek-v4 \
  --fixtures ./real-swebench-12.json --out ./ab-results
```

**Metrics per instance:** output text, latency_ms, tokens, cost, error; a
normalized similarity score ∈ [0,1] (mean of token-Jaccard and Levenshtein ratio);
latency delta `self − vendor` (negative ⇒ self-hosted faster); verdict
`MATCH` (≥0.9) / `CLOSE` (≥0.6) / `DIVERGE` (<0.6) / `ERROR`. **Aggregate:**
match rate, mean similarity, mean latency delta, total vendor vs self cost.

### The 12-instance set

A representative 12-instance SWE-bench-style fixture set ships at
`packages/memory/src/standalone/moa-local-ab.fixtures.json` (repos: requests,
flask, django, scikit-learn, pandas, sympy, matplotlib, astropy, pytest, scipy,
numpy, cpython). Each instance carries `{id, repo, problem_statement, expected}`.
Override with `--fixtures <path>` to point at the real SWE-bench instances
(or any JSON array of the same shape).

## 6. Honest deferral (shadow dry-run)

Per the Software Factory shadow phase:

- **vLLM/SGLang endpoint on Hetzner GPU** — the **socket** is complete and
  mechanically verified (tsc 0 errors, dry-run A/B_PASS, dormancy + arming +
  graceful-degradation unit-tested). The **live GPU endpoint** is provisioned by
  ZOU-414 (Hetzner annex, unmerged); a real `--live` run is deferred until the box
  is up and `ZO_VLLM_BASE_URL` is set. Not silently closed.
- **True SWE-bench pass@k** — the harness isolates **API-call overhead**
  (latency, cost) and **output parity** (similarity). Final pass@k resolution
  (running each instance's hidden test suite via the SWE-bench evaluation harness
  in Docker on the annex) is the live follow-up; it needs the annex + the SWE-bench
  eval image, neither of which exist in the gVisor sandbox.

The dry-run report is labelled **SIMULATED**; live numbers populate the same
report shape once the annex is provisioned.
