# Mobile applications - standard Template

Template: `mobile-app@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `84182901a729fd777fa1642a20b798606cecdf7d8a0be76efb6e4c44f5202b7d`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Phone or tablet products constrained by platform permissions, device lifecycle, connectivity, and distribution.

Examples: fitness tracker; expense scanner; field-service app; offline journal  
Counterexample: A responsive website with no native device capability or app-store distribution.

## Required Decisions

- [ ] **D-001** Which platforms and minimum OS versions are supported?
  - Answer: [required]
- [ ] **D-002** Which device permissions are necessary?
  - Answer: [required]
- [ ] **D-003** What offline and background behavior is required?
  - Answer: [required]
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
  - Answer: [required]

## Capabilities and Quality Requirements

- Handle permission granted, denied, restricted, and revoked states.
- Preserve committed work across backgrounding and process restart.
- Meet declared platform packaging and distribution requirements.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not claim cross-platform parity without device evidence.
- Do not request permissions before the user reaches the relevant workflow.

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

- Run the supported device and OS matrix.
- Exercise permission and lifecycle transitions.
- Verify offline and reconnect behavior where declared.

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
