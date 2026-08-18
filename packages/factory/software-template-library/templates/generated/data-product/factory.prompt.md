# Data products - factory Template

Template: `data-product@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `0f053e9184ff0930dc012fad94cb23f4aa7be7da229f1a92102cec95bc4e48cc`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Pipelines, analytical products, and decision surfaces governed by schema, lineage, freshness, quality, and reproducibility.

Examples: analytics dashboard; ETL pipeline; forecasting system; data-quality monitor  
Counterexample: A content website with no analytical or data-processing contract.

## Required Decisions

- [ ] **D-001** Which source systems and schemas are authoritative?
  - Answer: [required]
- [ ] **D-002** Which freshness, completeness, and quality thresholds apply?
  - Answer: [required]
- [ ] **D-003** How are backfills, late data, retention, and recovery handled?
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

- Validate data at each declared boundary.
- Record lineage, transformation version, and freshness metadata.
- Make backfill and partial-failure behavior idempotent and observable.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not silently coerce malformed records.
- Do not display metrics without source, timestamp, and definition.

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

- Run representative, missing, duplicate, late, and malformed data fixtures.
- Reproduce published metrics from versioned inputs.
- Exercise partial failure, retry, and backfill.

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
