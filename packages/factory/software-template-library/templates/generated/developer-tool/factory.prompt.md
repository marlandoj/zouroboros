# Developer tools - factory Template

Template: `developer-tool@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `c8209fa07a48bd9aebbae178b789ac146ab786cb0a593d184336c85b00edede1`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Tools consumed by developers through commands, configuration, generated artifacts, editor behavior, or machine-readable output.

Examples: CLI; linter; test runner; code generator  
Counterexample: A consumer application with no developer-facing contract.

## Required Decisions

- [ ] **D-001** Which commands, inputs, outputs, and exit codes are stable?
  - Answer: [required]
- [ ] **D-002** Which runtimes, versions, and project layouts are supported?
  - Answer: [required]
- [ ] **D-003** Which mutations require dry-run or confirmation?
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

- Document stable command and machine-output contracts.
- Return nonzero status for failed requested operations.
- Preserve user-authored content and provide deterministic fixtures.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not return exit zero after a failed requested operation.
- Do not mutate user projects without a dry run or explicit command.

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

- Run help, valid, invalid, and failure command fixtures.
- Test supported runtime and configuration matrices.
- Compare generated artifacts deterministically.

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
