# AI applications - factory Template

Template: `ai-application@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `01d920dae1eeab277004d7f1e0cb0f90aa1e0d69d58f2e6ff507bd73e2dc6ceb`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Products whose user-visible behavior materially depends on model inference, retrieval, classification, or generation.

Examples: RAG assistant; document classifier; coding copilot; support triage  
Counterexample: A deterministic rules engine that does not use model inference.

## Required Decisions

- [ ] **D-001** Which model capability, provider, data, and latency contracts apply?
  - Answer: [required]
- [ ] **D-002** Which evaluation set and thresholds govern release?
  - Answer: [required]
- [ ] **D-003** Which failures require fallback, refusal, or human review?
  - Answer: [required]
- [ ] **D-004** Which repository and branch policy are authoritative?
  - Answer: [required]
- [ ] **D-005** Who may approve promotion, merge, migration, deployment, and publication?
  - Answer: [required]
- [ ] **D-006** What is the scope-cut order?
  - Answer: [required]
- [ ] **D-007** What rollback restores code, data, and external side effects?
  - Answer: [required]

## Capabilities and Quality Requirements

- Version prompts, models, retrieval behavior, and evaluation fixtures.
- Expose uncertainty and defined refusal or escalation behavior.
- Keep evaluation and production execution paths equivalent.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not use model opinion as deterministic validation.
- Do not publish benchmark results from a path unavailable to production.

## Required Sections

- mission
- provenance
- contracts
- requirements
- dag
- ownership
- verification
- scope-policy
- rollout
- rollback
- authority

## Verification

- Run deterministic output-schema and safety checks.
- Evaluate quality on a versioned representative cohort.
- Exercise provider outage, timeout, refusal, and degraded-output paths.

Every acceptance criterion must link to a requirement and retained verification evidence.

## Scope Cut Order

1. [First optional capability to remove]
2. [Second optional capability to remove]
3. [Protected quality that may not be cut]

## Deliverables

- Source and template provenance
- Canonical build specification
- Tests and retained evidence
- Progress and decision record

## Out of Scope

- [Explicit exclusion]

## Authority

Resolution creates a candidate specification only; factory-ready, dispatch, merge, migration, deployment, publication, and courseware release require explicit human authority.
