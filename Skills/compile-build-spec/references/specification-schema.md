# Build Specification Schema

The canonical artifact is JSON. Markdown is a rendered view and must not become a second source of truth.

## Top-Level Shape

```json
{
  "schemaVersion": 1,
  "metadata": {},
  "mission": {},
  "factory": {},
  "constraints": [],
  "antiGoals": [],
  "protectedCapabilities": [],
  "scopeCutOrder": [],
  "decisions": [],
  "contracts": [],
  "requirements": [],
  "verifications": [],
  "canonicalScenarios": [],
  "acceptanceCriteria": [],
  "milestones": [],
  "humanCriteria": [],
  "deliverables": [],
  "outOfScope": [],
  "unresolved": []
}
```

## Metadata

Required fields:

- `project`, `version`, `date`, `owner`, `releaseTier`, `executionMode`
- `source.path`, `source.sha256`, `source.label`

Library-derived specifications also record `metadata.template.id`, exact `version`, `level`, resolved content `sha256`, and ordered annex IDs, versions, and hashes. These fields are optional for non-library sources but must survive rendering and candidate export when present.

`executionMode` is `direct`, `swarm`, or `undecided`. A conversion skill may recommend a mode but the factory dispatcher remains authoritative.

## Provenance

Every constraint, anti-goal, protected capability, requirement, and acceptance criterion carries:

- `origin`: `source` or `proposed`
- `sourceRefs`: source line references or exact short excerpts

Use `proposed` for additions such as deterministic simulation, fixed dependency pinning, or a new performance harness when the source did not explicitly require them.

## Factory Fields

```json
{
  "targetRepo": "workspace-relative path",
  "archetype": "dependency|docs|bugfix|feature|refactor|migration",
  "area": "affected area or reproduction context"
}
```

Do not invent these fields. Leave the decision unresolved until the operator supplies it.

## Requirements

```json
{
  "id": "FR-001",
  "type": "functional|nonfunctional",
  "text": "Observable requirement",
  "origin": "source|proposed",
  "sourceRefs": ["source:L10-L12"],
  "verificationIds": ["V-001"]
}
```

Use `FR-*` for functional behavior and `NFR-*` for quality, performance, reliability, security, accessibility, or lifecycle requirements.

## Contracts

```json
{
  "id": "SC-001",
  "name": "Canonical shared contract",
  "canonicalLocation": "src/path/file.ts",
  "consumers": ["system-a", "system-b"],
  "owner": "one accountable owner",
  "invariants": ["units", "ordering", "mutation authority"]
}
```

## Verification and Scenarios

```json
{
  "id": "V-001",
  "type": "static|unit|contract|integration|visual|temporal|performance|human",
  "method": "Command or review method",
  "threshold": "Measurable pass condition",
  "authority": "automated|agent|user|target-hardware"
}
```

```json
{
  "id": "CS-001",
  "name": "Stable scenario name",
  "setup": "Seed, viewport, fixture, or state",
  "action": "Action or captured state",
  "qualities": ["specific quality"],
  "evidence": "Expected artifact"
}
```

## Acceptance Criteria

```json
{
  "id": "AC-001",
  "text": "Measurable completion criterion",
  "origin": "source|proposed",
  "sourceRefs": ["source:L20-L22"],
  "requirementIds": ["FR-001", "NFR-001"],
  "verificationIds": ["V-001"],
  "authority": "automated|agent|user|target-hardware"
}
```

Every protected capability must map to at least one requirement and one acceptance criterion through `requirementIds`.

## Milestones and DAG

```json
{
  "id": "M0",
  "name": "Architecture and harness",
  "dependencies": [],
  "ownedPaths": ["src/core/"],
  "exitCriteria": ["AC-001"],
  "approval": "automated|agent|user"
}
```

Dependencies must exist and remain acyclic. Two unordered milestones may not own the same path.

## Decisions and Unresolved Items

Use `decisions` for options and evidence required before implementation. Use `unresolved` for missing inputs that block a trustworthy specification. Either causes `HOLD` when its status is not resolved.

## Human Criteria

Human criteria contain `id`, `question`, `scenarioIds`, and `approver`. They must ask focused questions against canonical evidence rather than request generic approval.
