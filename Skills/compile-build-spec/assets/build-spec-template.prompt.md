# Agentic Build Specification Standard and Template

Version: 1.0.0  
Status: Ready for use  
Updated: 2026-08-02

## Purpose

Use this standard to turn a product idea into an executable prompt for an AI coding agent or multi-agent team. It is designed for substantial builds where product taste, engineering constraints, verification, iteration, and human approval all matter.

The standard separates four concerns that should not be collapsed into vague prose:

1. **Creative brief:** what the product should feel like and why it matters.
2. **Build specification:** what must be implemented and what is prohibited.
3. **Evaluation plan:** how every important claim will be verified.
4. **Execution contract:** how work is decomposed, reviewed, resumed, and completed.

For small tasks, use only the applicable sections. For multi-session builds, retain the full structure.

## Normative Language

- **MUST:** required for completion.
- **MUST NOT:** prohibited.
- **SHOULD:** expected unless a documented reason justifies deviation.
- **MAY:** optional.
- **STRETCH:** explicitly outside the required definition of done.

Do not use words such as "polished," "fast," "production-ready," or "AAA-quality" without pairing them with observable characteristics and evidence.

## Standard Rules

1. State the user-visible outcome before naming technologies.
2. Separate desired outcomes from preferred implementation approaches.
3. Give every critical requirement a stable identifier.
4. Pair every quality claim with a test, capture, measurement, or human review.
5. Define canonical sources of truth before parallel implementation begins.
6. Assign exactly one owner to each shared contract or shared file.
7. Decompose parallel work as a dependency graph, not merely a list of specialties.
8. Define protected capabilities and a cut order before scope pressure appears.
9. Bound critique loops by severity, pass count, and escalation behavior.
10. Distinguish deterministic simulation from portable pixel identity.
11. Separate agent-verifiable results from results requiring target hardware or human judgment.
12. Require resumable project state for any multi-session build.
13. Treat technical prescriptions with unresolved feasibility as hypotheses requiring a spike or architecture decision.
14. Never claim completion while critical acceptance criteria lack evidence.

---

# Copy-Ready Template

Replace all bracketed fields. Remove instructional notes before execution.

## 0. Specification Metadata

- **Project:** [literal project name]
- **Specification version:** [version]
- **Date:** [YYYY-MM-DD]
- **Owner / final approver:** [name or role]
- **Execution environment:** [agent/platform/repository]
- **Target release:** [prototype, internal alpha, public beta, production]
- **Expected execution mode:** [single session, multi-session, multi-agent]

## 1. Mission

Build [literal product or capability] for [target user] so they can [primary job or outcome].

The first usable screen or command MUST [describe the immediate user experience]. The finished result should feel [three to five concrete experiential qualities].

This is a [release tier]. It is not a [explicitly excluded lower tier].

### Product References

Use these references for specific qualities, not imitation:

| Reference | Quality to borrow | Quality not to copy |
|---|---|---|
| [reference] | [interaction, composition, pacing, behavior] | [branding, characters, trade dress] |

## 2. Definition of Success

The build succeeds only when:

1. [Primary user journey] works end to end.
2. [Critical quality] meets [observable threshold].
3. [Reliability or performance target] is demonstrated by [evidence].
4. A clean environment can run it using [exact commands].
5. No critical or high-severity acceptance defect remains open.
6. The final approver accepts the human-judgment criteria listed in Section 15.

## 3. Users and Core Experience

### Primary User

- **Who:** [user/persona]
- **Context:** [where and why they use it]
- **Primary job:** [job to be done]
- **Expected skill level:** [novice/intermediate/expert]

### Core Journey

1. [Entry state]
2. [Primary action]
3. [Feedback or system response]
4. [Completion state]
5. [Recovery, replay, or next action]

### Experience Principles

- [Principle]: means [observable behavior].
- [Principle]: means [observable behavior].
- [Principle]: means [observable behavior].

## 4. Hard Constraints

### Technology

- Runtime: [runtime and minimum version]
- Language: [language and mode]
- Frameworks/libraries: [exact choices or decision boundary]
- Package manager: [tool]
- Supported platforms: [browser/OS/device]
- Required clean-run commands: `[commands]`
- Dependencies MUST be pinned or lockfile-resolved.

### Assets and Data

- [Rules for external assets, generated assets, licenses, fixtures, and test data]
- Runtime network access: [allowed origins or prohibited]
- Sensitive data: [handling requirements]

### Compatibility

- Target hardware: [device]
- Minimum supported hardware: [device]
- Display/input constraints: [resolution, DPR, keyboard, touch, controller]
- Accessibility baseline: [keyboard, contrast, reduced motion, screen reader, captions]

## 5. Anti-Goals and Mechanical Enforcement

| ID | Prohibited outcome or technique | Enforcement |
|---|---|---|
| AG-001 | [prohibition] | [lint rule, build assertion, dependency scan, test] |
| AG-002 | [prohibition] | [mechanical check] |

Prose-only prohibitions are insufficient when an automated check is practical.

## 6. Scope and Priority Policy

### Protected Capabilities

These MUST NOT be cut without explicit approval:

1. [capability]
2. [capability]
3. [quality attribute]

### Scope Cut Order

If time, context, or feasibility requires reduction, cut in this order and record the decision:

1. [lowest-value optional feature]
2. [next feature]
3. [next feature]

### Stretch Goals

- [stretch goal]
- [stretch goal]

Stretch goals MUST NOT delay required acceptance criteria.

## 7. Architecture Decisions and Feasibility Spikes

Resolve these before implementation or parallel fan-out:

| Decision | Options | Required evidence | Decision owner | Deadline |
|---|---|---|---|---|
| [renderer/database/protocol] | [options] | [spike, benchmark, compatibility test] | [owner] | [milestone] |

Record consequential decisions in [README/ADR path]. Once accepted, do not change them without documenting impact and rerunning affected acceptance tests.

## 8. Shared Contracts and Sources of Truth

Every domain concept MUST have one canonical definition.

| Contract | Canonical location | Consumers | Units/invariants | Owner |
|---|---|---|---|---|
| [state/model/API] | `[path or schema]` | [systems] | [units, coordinates, valid states] | [one owner] |

For each contract, specify:

- Data types and units.
- Coordinate system, clock, timezone, or frame of reference.
- Mutation authority and read-only consumers.
- Error and empty-state behavior.
- Versioning or migration behavior.
- Events emitted and ordering guarantees.
- A contract test proving producer-consumer agreement.

No subsystem may maintain a second copy of canonical data or logic.

## 9. Functional Requirements

Use stable IDs and observable behavior.

### [Subsystem or User Journey]

- **FR-001:** The system MUST [behavior] when [trigger].
- **FR-002:** The user MUST be able to [action], resulting in [observable state].
- **FR-003:** When [failure condition], the system MUST [recovery behavior].

For interaction-heavy products, include input, feedback, success, failure, restart, pause, and recovery behavior.

## 10. Non-Functional Requirements

### Performance

- **NFR-PERF-001:** Under [canonical stress scenario], [metric] MUST meet [threshold].
- Measure [CPU time, GPU time, latency, frame pacing, memory, bundle size].
- Use at least [sample count/duration] and report [p50/p95/p99, dropped-frame rate, error rate].
- Mean-only reporting is not sufficient for latency or frame pacing.

### Reliability

- **NFR-REL-001:** [restart/retry/offline/failure behavior].
- No unhandled browser-console or server errors during canonical journeys.
- Repeating [journey] [count] times MUST not produce measurable resource growth above [threshold].

### Determinism and Reproducibility

- Simulation or business logic MUST use [seed/fixed clock/input fixture] where applicable.
- Same build, seed, and inputs MUST produce matching state hashes or values within [tolerance].
- Rendered pixels MAY vary across hardware; visual regression uses [perceptual metric and threshold].

### Security and Privacy

- [authentication, authorization, secret handling, data retention, threat constraints]

### Accessibility and Lifecycle

- [keyboard navigation, focus, contrast, reduced motion, audio controls]
- Handle [window blur, suspend/resume, network loss, expired auth, empty data].

## 11. Execution Plan and Multi-Agent Contract

Parallel agents are optional. Use them only when tasks are independent after shared contracts are established.

### Execution Waves

| Wave | Task | Dependencies | Owned paths | Required output | Integration owner |
|---|---|---|---|---|---|
| 0 | Contracts and harness | None | [paths] | [tests/interfaces] | [owner] |
| 1 | [subsystem] | Wave 0 | [paths] | [artifact] | [owner] |

Rules:

1. Two active agents MUST NOT edit the same file.
2. Shared files have one owner; other agents propose changes through that owner.
3. Each task has entry criteria, exit criteria, and verification commands.
4. Integration occurs after each wave, not only at the end.
5. A failed dependency blocks its downstream tasks.
6. Concurrency MUST respect the execution environment's actual agent limit.

## 12. Verification Harness

Build the minimum reliable harness before feature implementation.

### Static Gates

- Formatting and linting: `[command]`
- Type checking: `[command]`
- Production build: `[command]`
- Forbidden dependency/asset/API checks: `[command]`

### Unit and Contract Tests

- [canonical math or state transition]
- [producer-consumer parity]
- [failure and boundary behavior]

### Integration and Journey Tests

- [clean start]
- [primary journey]
- [restart/recovery]
- [error and empty states]

### Visual Verification

- Deterministic seed/state: [value]
- Canonical viewport(s): [dimensions and DPR]
- Canonical camera or page states: [list]
- Compare with [pixel/perceptual threshold].
- Retain captures by milestone so regressions remain inspectable.

### Temporal Verification

Screenshots do not prove motion quality. Capture deterministic clips or time-separated frames for:

- [animation]
- [particles/water/transitions]
- [camera/input response]
- [loading and recovery]

### Hardware Verification Tiers

1. **Agent environment:** correctness, build, and available performance instrumentation.
2. **Reference CI/browser:** repeatable automated regression tests.
3. **Target hardware:** final performance and experience certification by [owner].

The agent MUST NOT claim target-hardware certification without target-hardware evidence.

## 13. Canonical Scenarios

| ID | Setup | Action/state | Qualities examined | Evidence |
|---|---|---|---|---|
| CS-001 | [seed/data/device] | [journey or frame] | [specific qualities] | [screenshot, clip, trace] |

Canonical scenarios remain stable across milestones. Add new scenarios when a new failure mode is discovered; do not silently delete regression coverage.

## 14. Acceptance Matrix

| Requirement | Acceptance criterion | Verification | Evidence artifact | Authority |
|---|---|---|---|---|
| FR-001 | [measurable outcome] | [test/capture/review] | `[path or report]` | [automated/agent/user] |

Every protected capability and critical quality attribute MUST appear in this matrix.

## 15. Human-Judgment Criteria

Automation cannot certify these alone:

- [handling feels responsive and weighty]
- [visual hierarchy reads clearly]
- [tone matches brand]

For each criterion, provide canonical evidence and a focused review question. The named final approver decides pass or revise.

## 16. Critique and Repair Loop

The critic outputs defects, not praise. Each defect includes:

- Severity: critical, high, medium, or low.
- Requirement or canonical scenario affected.
- Concrete evidence.
- Reproduction steps.
- Proposed verification after repair.

Loop policy:

1. Fix critical and high defects before milestone approval.
2. Re-run affected tests plus the regression baseline.
3. Run at most [number] critique passes per milestone before escalating.
4. If the same defect survives [number] repair attempts, stop varying the fix and reassess the underlying design.
5. Medium and low defects may be deferred only with the final approver's recorded acceptance.

The stopping condition is not "the critic has nothing else to say." It is "all required criteria pass, no critical/high defects remain, and deferred defects have explicit authority."

## 17. Milestones and Approval Gates

| Milestone | Playable/usable increment | Entry criteria | Exit criteria | Required evidence | Approval |
|---|---|---|---|---|---|
| M0 | Architecture and harness | [criteria] | [criteria] | [tests/ADR] | [owner] |
| M1 | [increment] | M0 approved | [criteria] | [captures/report] | [owner] |

At each milestone:

1. Leave the repository runnable and tests green.
2. Update the progress artifact.
3. Record current quality honestly, including named defects.
4. Present the required evidence.
5. Stop for approval when the specification assigns approval to a human.

## 18. Living Progress Artifact

Maintain `[PROGRESS.md or STATUS.md]` with:

| Subsystem | Target | Current evidence | Open defects | Next action | Owner |
|---|---|---|---|---|---|
| [subsystem] | [target] | [evidence] | [defects] | [action] | [owner] |

Also record:

- Current milestone and authoritative status.
- Completed and pending acceptance criteria.
- Architecture decisions and scope changes.
- Exact blocker and recovery action.
- Commands needed to resume safely.

## 19. Required Deliverables

- Working product or implementation.
- README with clean-run instructions and architecture overview.
- Pinned dependency state or lockfile.
- Automated tests and verification scripts.
- Current progress/status artifact.
- Acceptance evidence and retained regression captures.
- Known limitations and accepted deferred defects.
- No unrelated workspace changes.

## 20. Definition of Done

The project is complete only when:

- All protected capabilities are reachable through a real user or production path.
- Required data, schemas, configuration, and bootstrap state exist.
- Cross-process and restart behavior is verified where applicable.
- Production and evaluation use the same code paths.
- All acceptance criteria have evidence.
- Static checks, tests, and production build pass.
- No critical/high defects remain.
- Target-hardware claims are either verified or explicitly marked pending.
- The final approver accepts all assigned human-judgment criteria.
- The repository and progress artifact are left resumable and internally consistent.

## 21. Final Execution Instruction

Before implementation:

1. Inspect the current repository and relevant project documentation.
2. Validate this specification against the actual environment.
3. Identify contradictions, infeasible requirements, missing contracts, and untestable claims.
4. Amend or escalate those issues before building.
5. Establish the verification harness and shared contracts.

During implementation, work milestone by milestone. Do not substitute implementation existence for reachability, tests passing for visual quality, screenshots for temporal quality, or local success for target-hardware certification.

---

# Prompt Quality Preflight

Score the completed specification before execution. A score below 80, or any critical failure, requires revision.

| Category | Weight | Pass question |
|---|---:|---|
| Product clarity | 15 | Is the literal user outcome unmistakable? |
| Feasibility | 15 | Are major technical risks resolved or assigned spikes? |
| Falsifiability | 20 | Can every critical claim be proven or reviewed? |
| Architecture coherence | 15 | Are shared contracts canonical and owned? |
| Scope control | 10 | Are protected features and cut order explicit? |
| Execution safety | 10 | Are dependencies, ownership, and approval boundaries clear? |
| Verification depth | 15 | Do tests cover static, functional, visual/temporal, and performance concerns as applicable? |

Critical failures:

- No clean-run command.
- No definition of done.
- Critical subjective claims without a human review authority.
- Parallel work before shared contracts or with overlapping file ownership.
- Performance target without a canonical scenario and measurement method.
- Unbounded critique or repair loop.
- Target-hardware certification claimed without target-hardware evidence.
- Protected capability absent from the acceptance matrix.

# Domain Annex Template

Use one annex per specialized domain, such as rendering, finance, healthcare, data migration, AI evaluation, or infrastructure.

## Domain: [Name]

- **Why it matters:** [user-visible importance]
- **Domain constraints:** [rules, standards, physical or business invariants]
- **Canonical model:** [single source of truth]
- **Required behaviors:** [requirement IDs]
- **Forbidden shortcuts:** [anti-goal IDs]
- **Risky technical assumptions:** [spikes/decisions]
- **Canonical scenarios:** [scenario IDs]
- **Quality metrics:** [thresholds]
- **Human review questions:** [questions]
- **Owner:** [one accountable owner]

