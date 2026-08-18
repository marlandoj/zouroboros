# Games - factory Template

Template: `game@1.0.0`  
Level: `factory`  
Catalog: `1.0.0`  
Template SHA-256: `95f973c4a8cc2e5005159030d93041e331eb7e7f67352b05aa9ed3680f6f62d5`  
Maturity: `published`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

Interactive entertainment products governed by a game loop, controls, rules, feedback, content, and performance.

Examples: boat racer; puzzle game; roguelike; multiplayer arena  
Counterexample: A scientific physics sandbox whose primary purpose is measurement rather than play.

## Required Decisions

- [ ] **D-001** What is the repeatable core loop and win or loss condition?
  - Answer: [required]
- [ ] **D-002** Which controls, platforms, and target hardware apply?
  - Answer: [required]
- [ ] **D-003** Which art, audio, physics, and performance qualities are protected?
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

- Maintain deterministic game-state transitions under a declared seed where feasible.
- Provide responsive controls and explicit pause, restart, focus-loss, and input-device behavior.
- Meet the declared frame-time budget in a repeatable stress scenario.

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve `latest` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

- Do not use screenshots as the only evidence for motion or feel.
- Do not expand content before the core loop is playable and verified.

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

- Replay canonical input and state scenarios.
- Capture time-separated visual or video evidence.
- Measure frame times and dropped frames on the target tier.

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
