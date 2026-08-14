# zouroboros-rag

## Unreleased

### Bug Fixes

- ZOU-747: `daily-rag-maintenance` now resolves `SWARM_ID` result files correctly, skips malformed/incomplete swarm result files instead of throwing, and calls the renamed `scripts/swarm-retrieval.ts` capture helper. Test coverage added in `src/__tests__/rag-swarm-retrieval.test.ts`.

## 1.1.1

### Patch Changes

- 4c29da6: Validate and republish `zouroboros-rag` for standalone npm consumption (Packaging M5, ZOU-479). The npm build was a stale pre-packaging artifact (1.1.0) that predated the M1–M4 hardening review. This republish runs the package through the same clean-room validation as its M5 siblings and ships a version-bumped, verified artifact.

  Like `zouroboros-personas` and `zouroboros-workflow`, `zouroboros-rag` required no source changes. The published surface is a pure library: `dist/index.js` exports the `RagArea`/`RagConfig` types plus a few constants, and its only path resolution delegates to `getMemoryDbPath()` from `zouroboros-core` (env-aware: honors `ZOUROBOROS_MEMORY_DB`/`ZO_MEMORY_DB`, falls back to `~/.zouroboros/memory.db`). It carries no hardcoded `/home/workspace` root, no `sqlite3` CLI shellout, ships no bins, and declares `zouroboros-core` as a real runtime dependency. The `scripts/` CLIs (which do reference a workspace root) are both `tsconfig`-excluded and absent from the `files` allowlist, so they never enter the tarball.

  Validation confirmed: `tsc --noEmit` clean, tarball is `dist/` + `README` + `package.json` only, `dist/` carries no `/home/workspace` literals and no `sqlite3` shellout, and the compiled library imports cleanly from an isolated temp dir — `MEMORY_DB_PATH` resolves to the `~/.zouroboros` default and re-resolves to a caller-supplied path when `ZOUROBOROS_MEMORY_DB` is set.

  No public API changes; validation + version bump only.

## 1.1.0

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
