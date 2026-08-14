# zouroboros-workflow

## 2.1.1

### Patch Changes

- 39d2a22: Validate and republish `zouroboros-workflow` for standalone npm consumption (Packaging M5, ZOU-478). The npm build was a stale pre-packaging artifact (2.1.0) that predated the M1–M4 hardening review. This republish runs the package through the same clean-room validation as its M5 siblings and ships a version-bumped, verified artifact.

  Like `zouroboros-personas`, `zouroboros-workflow` required no source changes: every stage (interview/evaluate/unstuck/autoloop) operates on caller-supplied paths, carries no hardcoded `/home/workspace` root in its shipped surface, uses no `sqlite3` CLI shellout, and already ships portable `#!/usr/bin/env bun` shebangs with correct runtime dependencies. The only `/home/workspace` literals live in `src/autoloop/standalone/*` (the MCP-server variants), which are `tsconfig`-excluded and never ship in the tarball. Validation confirmed: `tsc --noEmit` clean, tarball is `dist/` + `README` only, `dist/` carries no `/home/workspace` literals and no `sqlite3` shellout, and all four compiled bins run end-to-end in an isolated temp dir (interview/evaluate/unstuck `--help` and `autoloop --dry-run` all exit 0, program validated from a caller-relative path).

  No public API changes; validation + version bump only.

## 2.1.0

### Minor Changes

- Zouroboros v2.1.0 — coordinated release of enhancements and fixes since v2.0.0.

  - selfheal: consensus-gate reputation/quarantine + banned-model doctor, curiosity chronicle proposal feed, Snake Pit adversarial red-team layer, endogenous curiosity explorer, gated periodic distillation pipeline.
  - memory: live retrieval/store telemetry wiring (memory_retrievals / memory_stores), graph-connectivity and decay refinements.
  - swarm: ACP transport, T3 runner, RAG enrichment, hierarchical delegation.
  - rag: orphan-chunk sweeper and retired-path guards.

  `zouroboros-memory` baseline reconciled to 4.0.0 to match the published registry version before this minor bump (→ 4.1.0).

### Patch Changes

- Updated dependencies
  - zouroboros-core@2.1.0
