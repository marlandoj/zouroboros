# Software Factory Integration

The skill is an upstream compiler, not an execution authority.

## Current Live Path

The live conveyor accepts a Linear Intake issue carrying `factory-ready`, validates its contract, then lets the dispatcher choose DIRECT or SWARM.

The exported ticket must use these exact headers:

```markdown
## Acceptance Criteria
## Target Repo
## Archetype
## Repro
```

Do not emit `## Repro / Area`; the production parser does not accept the spaced-slash header.

Supported coarse archetypes are:

- `dependency`
- `docs`
- `bugfix`
- `feature`
- `refactor`
- `migration`

Validate an exported candidate before the operator applies `factory-ready`:

```bash
cd /home/workspace/Projects/zouroboros-software-factory/scripts
bun ticket-contract.ts --dry-run --tickets /absolute/ticket-array.json
```

## Authority Boundary

The skill may:

- Preserve and hash a source prompt.
- Produce a normalized specification.
- Run deterministic and consensus review.
- Generate candidate ticket and seed files.

The skill may not:

- Create or mutate Linear records.
- Add labels or change states.
- Dispatch the factory.
- Choose an authoritative execution mode.
- Merge, publish, deploy, or send external communications.

## Swarm Mapping

When the dispatcher chooses SWARM:

- `milestones` provide the task DAG.
- `contracts` define shared ownership boundaries.
- `acceptanceCriteria` and `verifications` feed seed evaluation.
- `canonicalScenarios` define retained evidence.
- `unresolved` must be empty before execution.
- Post-flight evaluation and the five-part gap audit remain downstream gates.

Do not duplicate or bypass the factory's spec interview, seed evaluation, post-flight evaluation, or gap audit. The compiler improves the intake artifact those gates receive.

