# Web applications - standard Template

Template: `web-app@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `408102da663410730a686d077296d0689801bfdf7a2671251b61dc5043a5dbfb`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Browser-delivered products centered on pages, forms, workflows, and responsive interaction.

Examples: habit tracker; booking system; CRM; portfolio builder  
Counterexample: A headless payment API whose primary contract is machine-to-machine.

## Required Decisions

- [ ] **D-001** Which user journey is primary?
  - Answer: [required]
- [ ] **D-002** Which browsers and responsive breakpoints are supported?
  - Answer: [required]
- [ ] **D-003** What persistence and authentication, if any, are required?
  - Answer: [required]
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
  - Answer: [required]

## Capabilities and Quality Requirements

- Render every primary workflow with loading, empty, error, and populated states.
- Support keyboard navigation and declared accessibility targets.
- Preserve user-visible state across the declared persistence boundary.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not require a backend when local persistence satisfies the product.
- Do not infer authentication or payments from visual similarity alone.

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

- Run browser flows for the primary journey.
- Capture desktop and mobile evidence.
- Run accessibility and static checks.

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
