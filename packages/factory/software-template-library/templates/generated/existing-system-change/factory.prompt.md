# Existing-system changes - factory Template

Template: `existing-system-change@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `f9c20b1b3cf854921846585ee15de8d780eadd57fa304b7522e5633f2ec14526`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Brownfield features, fixes, migrations, refactors, and remediations constrained by existing behavior and repository contracts.

Examples: feature addition; schema migration; refactor; reliability remediation  
Counterexample: A greenfield product with no existing code, data, users, or compatibility obligations.

## Required Decisions

- [ ] **D-001** Which current behavior and interfaces are protected?
  - Answer: [required]
- [ ] **D-002** Which files, schemas, callers, and deployments are affected?
  - Answer: [required]
- [ ] **D-003** Which rollout, compatibility, data, and rollback constraints apply?
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

- Reproduce or document the current behavior before editing.
- Preserve protected capabilities and unrelated user changes.
- Verify callers, migrations, configuration, and runtime paths after the change.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not redesign unrelated modules during a bounded change.
- Do not delete or rename without sweeping live references.

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

- Run focused regression and protected-behavior tests.
- Trace affected callers and configuration references.
- Exercise rollout and rollback or forward-repair paths.

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
