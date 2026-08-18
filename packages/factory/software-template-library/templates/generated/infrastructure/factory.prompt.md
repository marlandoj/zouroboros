# Infrastructure - factory Template

Template: `infrastructure@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `e97edfb28fbf13e1a5c2e85e10a53d7ed5bba34a68d4f7d299000cbaa0fa42cf`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Runtime, deployment, monitoring, backup, and platform capabilities whose failures affect other systems.

Examples: deployment pipeline; monitoring service; backup system; internal worker  
Counterexample: A static local document with no runtime or operational dependency.

## Required Decisions

- [ ] **D-001** Which environments, consumers, identities, and network boundaries apply?
  - Answer: [required]
- [ ] **D-002** Which service objectives, rollback, backup, and recovery targets apply?
  - Answer: [required]
- [ ] **D-003** Who owns incidents and destructive changes?
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

- Identify the concrete production caller, trigger, or consumer.
- Use least-privilege identities and explicit secret boundaries.
- Provide health, rollback, backup, and recovery evidence.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not equate a passing health check with a live consumer.
- Do not provision persistent cost without an identified caller or trigger.

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

- Run transport, health, failure-injection, and recovery tests.
- Prove reachability from the named production consumer.
- Exercise backup restoration and rollback without relying on the failed system.

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
