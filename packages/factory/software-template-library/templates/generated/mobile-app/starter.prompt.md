# Mobile applications - starter Template

Template: `mobile-app@1.0.0`  
Level: `starter`  
Catalog: `1.0.0`  
Template SHA-256: `361f9e81a9f90b40447be39849c2a4878b57d1eb49b0d8fd871b94bcef0e5593`  
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
- [ ] **D-004** What is the smallest usable vertical slice?
  - Answer: [required]
- [ ] **D-005** What must explicitly remain out of scope?
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
- capabilities
- constraints
- acceptance
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
