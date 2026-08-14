---
name: classifier-fallback
description: >-
  Detector for model classifier SOFT-blocks — refusals, filtered-to-empty,
  truncated-with-disclaimer, content-policy flags — that masquerade as
  successful empty output to existing infrastructure (agent-model-healer only
  catches HARD failures: HTTP 4xx/5xx, timeouts, genuine empties). Classifies an
  output as soft_block / genuine_empty / ok using a per-provider signal catalog,
  then routes a per-domain fallback (security → broader-tolerance model, bio/chem
  → human review, distillation → refuse-by-design, never routed around). Every
  block + fallback is appended to an audit ledger. A quarterly system-card-diff
  agent flags expanded classifier scope so the catalog stays current.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: "1.0.0"
  linear: ZOU-493
  aiewf: SIL-14
  category: zouroboros-infrastructure
  depends_on: consensus-gate (reviewer-independence.ts, for future ≠author fallback panels)
classifier-surfaces:
  - security
  - bio
  - chem
  - distillation
fallback-behavior: >-
  Detects and routes soft blocks; does NOT route around refuse-by-design domains
  (distillation) — those are intentional provider guardrails, not failures.
---

# Classifier-Fallback — Detector for model soft-blocks (SIL-14)

Detects and routes around classifier SOFT blocks — refusals, filtered-to-empty,
truncated-with-disclaimer, content-policy flags — that look like successful
empty output to existing infrastructure (agent-model-healer only catches hard
failures: HTTP 4xx/5xx, timeouts, genuine empties).

## When to use

- After any model output is received, before treating it as a successful result
- In the agent-model-healer probe loop (future wiring, path B — currently standalone)
- In any pipeline that sends security/bio/chem/distillation-classified tasks

## Commands

```bash
# Classify a single output (returns JSON: block-type, confidence, fallback-action)
bun Skills/classifier-fallback/scripts/detector.ts classify \
  --output "I can't help with that" --provider anthropic --domain security

# Run the built-in test suite (T2/T3/T4 acceptance, 20 checks)
bun Skills/classifier-fallback/scripts/detector.ts test

# Show the fallback map for a task domain
bun Skills/classifier-fallback/scripts/detector.ts map --domain security

# Quarterly classifier-scope audit: baseline, then scan each quarter
bun Skills/classifier-fallback/scripts/system-card-diff.ts baseline   # seed snapshots
bun Skills/classifier-fallback/scripts/system-card-diff.ts scan --json # detect expansions
```

## Configuration & artifacts

- `assets/classifier-catalog.json` — per-provider signal patterns (refusal,
  filtered_empty, truncated_disclaimer, policy_flag) + generic fallback tier
- `assets/fallback-map.json` — per-domain fallback routing
- `assets/system-card-urls.json` — provider policy pages the quarterly diff watches
- `assets/classifier-blocks.jsonl` — append-only audit ledger (auto-created,
  gitignored runtime artifact). One JSON object per line:
  `{ timestamp, provider, model, task_class, domain, detection{result,block_type,confidence,matches[],output_length}, fallback{action,fallback_model?,...}, task_id? }`
- `assets/card-snapshots/` — gitignored raw policy-page snapshots for the diff

## Skill frontmatter contract

Skills that may emit classifier-touching tasks declare which surfaces they touch,
so the detector's per-domain fallback map applies:

```yaml
classifier-surfaces: [security, bio, chem, distillation]
```
