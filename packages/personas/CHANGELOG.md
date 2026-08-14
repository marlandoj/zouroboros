# zouroboros-personas

## 2.1.1

### Patch Changes

- 0a2d6a7: Validate and republish `zouroboros-personas` for standalone npm consumption (Packaging M5, ZOU-477). The npm build was a stale pre-packaging artifact (2.1.0) that predated the M1–M4 hardening review. This republish runs the package through the same dual-lane clean-room validation as its M5 siblings and ships a version-bumped, verified artifact.

  Unlike the other M5 packages, `zouroboros-personas` required no source changes: it was written path-injection-first (analytics/marketplace/generator all take caller-supplied `dataDir`/`personasDir`/`outputDir` with relative defaults), carries no hardcoded `/home/workspace` root, uses no `sqlite3` CLI shellout, and already ships a portable `#!/usr/bin/env bun` shebang with correct runtime dependencies. Validation confirmed: `tsc` clean, tests pass, tarball is `dist/` + `README` only, and the compiled bin runs end-to-end in an isolated temp dir (help/validate/create all exit 0, personas written to a caller-relative path).

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
