# Desktop applications - standard Template

Template: `desktop-app@1.0.0`  
Level: `standard`  
Catalog: `1.0.0`  
Template SHA-256: `3d7b5bd390aad8168d3ac79acdd75b22c359f5b7977cec2608b767b5bb37e06e`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Installed workstation products using local files, operating-system integration, packaging, and upgrade behavior.

Examples: Markdown editor; media organizer; trading workstation; local research vault  
Counterexample: A browser-only dashboard with no local filesystem or desktop distribution needs.

## Required Decisions

- [ ] **D-001** Which operating systems and architectures are supported?
  - Answer: [required]
- [ ] **D-002** Which filesystem locations and file formats are authoritative?
  - Answer: [required]
- [ ] **D-003** How are upgrades, rollback, and data recovery handled?
  - Answer: [required]
- [ ] **D-004** Which data and lifecycle contracts are authoritative?
  - Answer: [required]
- [ ] **D-005** Which failure and recovery behavior is required?
  - Answer: [required]
- [ ] **D-006** What deployment environment is authoritative?
  - Answer: [required]

## Capabilities and Quality Requirements

- Use atomic or recoverable writes for user-owned files.
- Handle missing, locked, malformed, and externally modified files.
- Package and update the application on declared operating systems.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not overwrite user files without recoverable backups.
- Do not promise OS support that is not exercised.

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

- Run filesystem failure and recovery fixtures.
- Test packaging and upgrade on each declared OS.
- Verify data remains readable across supported versions.

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
