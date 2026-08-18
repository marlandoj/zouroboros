# 3D and simulations - standard Template

Template: `simulation-3d@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `3ce0f4fe29d3bc94971030f7d82219541d40356b04e0a3dace1678d93494c774`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Spatial or numerical systems whose correctness depends on coordinate, time, physics, rendering, and model parity.

Examples: driving simulator; architectural viewer; physics sandbox; digital twin  
Counterexample: A stylized 2D game with no model-fidelity or spatial-analysis requirement.

## Required Decisions

- [ ] **D-001** Which coordinate systems, units, and time model are canonical?
  - Answer: [required]
- [ ] **D-002** Which physical or visual reference establishes correctness?
  - Answer: [required]
- [ ] **D-003** Which hardware and tolerance budgets apply?
  - Answer: [required]
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
  - Answer: [required]

## Capabilities and Quality Requirements

- Use one canonical definition for shared simulation parameters.
- Keep coupled CPU and GPU calculations within declared tolerance.
- Separate deterministic state validation from tolerant visual comparison.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not claim physical fidelity without a reference model and tolerance.
- Do not require pixel-identical rendering across different GPUs.

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

- Compare numerical results against canonical fixtures.
- Run parity tests across coupled implementations.
- Capture temporal, visual, and target-hardware performance evidence.

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
