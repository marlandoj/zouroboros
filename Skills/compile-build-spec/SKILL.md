---
name: compile-build-spec
description: Convert, normalize, lint, review, and export free-form software build prompts as provenance-preserving Agentic Build Specifications. Use when refining an internet prompt, making requirements measurable, preparing a prompt for consensus review, generating a Software Factory ticket or seed, or defining a swarm-ready task DAG without dispatching execution.
metadata:
  author: marlandoj.zo.computer
  version: 1.0.0
---

# Compile Build Spec

Turn a free-form build prompt into a typed, reviewable specification while preserving what the source actually said and distinguishing proposed improvements from unresolved decisions.

## Choose a Mode

- **Simple prompt:** Use `assets/build-spec-template.prompt.md` directly and retain only applicable sections.
- **Normalized specification:** Follow the full workflow below and produce canonical JSON plus rendered Markdown.
- **Consensus review:** Run the deterministic validator first, then the existing plan-consensus gate.
- **Factory or swarm preparation:** Export a contract-shaped Linear ticket and immutable seed candidate. Never label or dispatch automatically.

## Full Workflow

### 1. Preserve the Source

```bash
bun Skills/compile-build-spec/scripts/spec-tool.ts ingest \
  --input /absolute/source.prompt.md \
  --output /absolute/source-manifest.json
```

Do not edit the source prompt. Use the SHA-256 manifest as provenance.

### 2. Author the Canonical Specification

Read `references/specification-schema.md`, then convert the source into canonical JSON.

Rules:

1. Mark requirements copied or faithfully paraphrased from the source as `source`.
2. Mark quality or engineering improvements absent from the source as `proposed`.
3. Put decisions that cannot be inferred safely in `unresolved`.
4. Preserve every load-bearing source requirement or list it explicitly as an intentional exclusion.
5. Give requirements, verifications, scenarios, acceptance criteria, contracts, and milestones stable IDs.
6. Link every acceptance criterion to requirements and verification evidence.
7. Assign one owner to shared contracts and avoid unordered overlapping milestone paths.
8. Do not invent a repository, target hardware result, credential, budget, or human approval.

### 3. Validate and Render

```bash
bun Skills/compile-build-spec/scripts/spec-tool.ts validate \
  --spec /absolute/build-spec.json \
  --source /absolute/source.prompt.md

bun Skills/compile-build-spec/scripts/spec-tool.ts render \
  --spec /absolute/build-spec.json \
  --output /absolute/build-spec.prompt.md
```

Validation returns:

- `PASS`: structurally valid, score at least 80, no unresolved decisions.
- `HOLD`: structurally valid but incomplete, under-scored, or unresolved.
- `FAIL`: broken references, provenance, IDs, DAG, or required fields.

Never reinterpret `HOLD` as approval.

### 4. Run Consensus Review

```bash
bun Skills/compile-build-spec/scripts/spec-tool.ts review \
  --spec /absolute/build-spec.json \
  --output /absolute/consensus-review.json \
  --label project-build-spec
```

The review uses `Skills/consensus-gate/scripts/plan-consensus-gate.ts` in sufficiency mode. Default criteria are:

`source-fidelity,requirement-completeness,technical-feasibility,falsifiability,architecture-coherence,scope-control,verification-quality,execution-safety`

Provider failure or escalation yields `HOLD`. Consensus never rewrites the artifact. Apply only verified findings, rerun deterministic validation, and stop after two repair rounds for human review.

Use `--dry-run` to inspect the review request without calling providers.

### 5. Export for the Software Factory

Read `references/factory-integration.md` before exporting.

```bash
bun Skills/compile-build-spec/scripts/spec-tool.ts export-ticket \
  --spec /absolute/build-spec.json \
  --output /absolute/factory-ticket.md

bun Skills/compile-build-spec/scripts/spec-tool.ts export-seed \
  --spec /absolute/build-spec.json \
  --output /absolute/factory-seed.yaml
```

Export requires deterministic validation to pass and factory fields to be complete. The skill creates candidate artifacts only. It must not:

- Create or update a Linear issue.
- Apply `factory-ready`.
- Invoke the dispatcher or conveyor.
- Execute the generated specification.
- Merge or publish anything.

The operator retains those authorities.

## Required Outputs

For a full conversion, retain:

- Immutable source prompt.
- Source manifest with SHA-256.
- Canonical Build Specification JSON.
- Rendered `.prompt.md` view.
- Deterministic validation report.
- Consensus review report when requested.
- Factory ticket and seed candidates when requested.
- A conversion report naming retained, proposed, unresolved, and intentionally excluded requirements.

## Included Fixture

`assets/fixtures/original-vyon-26-boat-racer.prompt.md` is the first provenance fixture. Use it to validate ingestion and as a realistic conversion exercise. Identify it by hash, not by informal version labels.
