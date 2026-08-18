# Data products - standard Template

Template: `data-product@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `b01d7628de27a33c04c82531decac36e44c4ea285d56ab261ebc6e680ee54be9`  
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
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
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
- users
- workflows
- data
- security
- lifecycle
- quality
- verification
- exclusions

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
