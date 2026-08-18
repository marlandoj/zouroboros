# Automation - standard Template

Template: `automation@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `a5942b219d4b0701ecd5e89b1475e282ad27b7e42927ed8b4037b4ff16052a1a`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Triggered workflows that perform repeatable actions, often with external side effects and unattended failure modes.

Examples: email triage; report generator; scheduled sync; compliance reminder  
Counterexample: An interactive dashboard that never performs scheduled or event-driven actions.

## Required Decisions

- [ ] **D-001** Which trigger, cadence, time zone, and concurrency rules apply?
  - Answer: [required]
- [ ] **D-002** Which side effects require approval?
  - Answer: [required]
- [ ] **D-003** Which failures retry, alert, pause, or require reconciliation?
  - Answer: [required]
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
  - Answer: [required]

## Capabilities and Quality Requirements

- Make each repeatable side effect idempotent or explicitly non-retriable.
- Record trigger, attempt, outcome, and reconciliation identity.
- Report material failure through an owned channel.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not retry irreversible actions without an idempotency contract.
- Do not treat silence as successful completion.

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

- Replay duplicate and overlapping triggers.
- Inject transient and permanent failures.
- Verify success, partial success, retry, and escalation records.

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
