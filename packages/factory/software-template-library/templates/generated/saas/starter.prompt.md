# SaaS products - starter Template

Template: `saas@1.0.0`  
Level: `starter`  
Catalog: `1.0.0`  
Template SHA-256: `5f3e1d672edf5bd45fbdbc4bf5fa1975de020f6e9a794adaccba9f1a6d2feae9`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Hosted multi-user products with accounts, roles, persistent organizational data, and service lifecycle behavior.

Examples: subscription analytics; inventory management; team workspace; client portal  
Counterexample: A single-user local tool with no accounts, shared data, or hosted service.

## Required Decisions

- [ ] **D-001** What is the tenant boundary?
  - Answer: [required]
- [ ] **D-002** Which roles and ownership rules apply?
  - Answer: [required]
- [ ] **D-003** Which subscription and account lifecycle states exist?
  - Answer: [required]
- [ ] **D-004** What is the smallest usable vertical slice?
  - Answer: [required]
- [ ] **D-005** What must explicitly remain out of scope?
  - Answer: [required]

## Capabilities and Quality Requirements

- Isolate tenant data on every server-side access path.
- Enforce role and ownership permissions for each protected action.
- Represent trial, active, past-due, canceled, and recovery states when billing is in scope.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not add multi-tenancy to a single-user prototype.
- Do not treat client-side role checks as authorization.

## Required Sections

- mission
- capabilities
- constraints
- acceptance
- exclusions

## Verification

- Run cross-tenant denial tests.
- Exercise role and lifecycle transition matrices.
- Reconcile billing and account state where applicable.

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
