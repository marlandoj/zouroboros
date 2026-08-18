# SaaS products - factory Template

Template: `saas@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `6cb27bdc581fdc5a386c80941458fea9bc1a3a206565b9caaf01ef13da614e58`  
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
- [ ] **D-004** Which repository and branch policy are authoritative?
  - Answer: [required]
- [ ] **D-005** Who may approve promotion, merge, migration, deployment, and publication?
  - Answer: [required]
- [ ] **D-006** What is the scope-cut order?
  - Answer: [required]
- [ ] **D-007** What rollback restores code, data, and external side effects?
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
