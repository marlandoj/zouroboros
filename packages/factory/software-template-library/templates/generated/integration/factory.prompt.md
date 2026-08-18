# Integrations - factory Template

Template: `integration@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `3fa00d5e2ef5bdd99c75e5ac4595c8a399b6a96e67610dad2d34173d1ddabd41`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Connections between independently governed systems with authentication, mapping, rate, consistency, and reconciliation boundaries.

Examples: Stripe billing; Linear sync; CRM connector; calendar bridge  
Counterexample: An internal function call within one codebase and one transaction boundary.

## Required Decisions

- [ ] **D-001** Which system is authoritative for each field and lifecycle state?
  - Answer: [required]
- [ ] **D-002** Which authentication and credential-rotation model applies?
  - Answer: [required]
- [ ] **D-003** How are rate limits, duplicates, drift, and reconciliation handled?
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

- Version field and enum mappings.
- Handle rate limits, pagination, retries, and idempotency explicitly.
- Detect and reconcile divergence without silently overwriting authoritative state.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not assume remote identifiers or enum values are stable.
- Do not expose integration credentials to clients or logs.

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

- Run mapping and contract fixtures against authoritative schemas.
- Exercise pagination, rate limit, duplicate, deletion, and drift scenarios.
- Verify credential redaction and rotation behavior.

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
