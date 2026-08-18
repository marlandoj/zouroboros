# APIs and backends - standard Template

Template: `api-backend@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `70cc98d7debfe5ae42fa0d1b26f02009ca1086a499d0df6c9f4b4d063a85c6e6`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Machine-facing services governed by endpoint, schema, authorization, error, reliability, and compatibility contracts.

Examples: authentication service; payment API; notification service; content API  
Counterexample: A static portfolio whose primary behavior is rendered content.

## Required Decisions

- [ ] **D-001** Which protocol, schema, and compatibility policy are authoritative?
  - Answer: [required]
- [ ] **D-002** Which callers and authorization rules apply?
  - Answer: [required]
- [ ] **D-003** Which latency, throughput, and availability budgets apply?
  - Answer: [required]
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
  - Answer: [required]

## Capabilities and Quality Requirements

- Validate inputs and authorization before side effects.
- Return stable machine-readable error contracts.
- Preserve declared backward compatibility or version explicitly.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not expose internal exceptions as public API contracts.
- Do not infer idempotency or compatibility behavior.

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

- Run schema and consumer contract tests.
- Exercise authentication, authorization, malformed input, and idempotency.
- Measure load and recovery against declared budgets.

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
