# Infrastructure - standard Template

Template: `infrastructure@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `237fd37e18561e24d28016eb50808e41158f415557d4ec88fdde83ccf48678e1`  
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
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
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
- users
- workflows
- data
- security
- lifecycle
- quality
- verification
- exclusions

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
