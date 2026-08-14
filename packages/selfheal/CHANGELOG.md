# zouroboros-selfheal

## 2.1.1

### Patch Changes

- 9adc906: Harden `zouroboros-selfheal` for standalone npm consumption (Packaging M5, ZOU-475). The npm build was a stale pre-packaging artifact that assumed the monorepo layout and an on-PATH `sqlite3` binary. This republish applies the M1–M4 hardening:

  - Path-decouple: `/home/workspace` runtime defaults replaced with `getWorkspaceRoot()` (honours `ZOUROBOROS_WORKSPACE`/`ZO_WORKSPACE`, falls back to cwd).
  - Native persistence: shipped modules use `bun:sqlite` directly instead of shelling out to the `sqlite3` CLI; all writes use parameterized binding.

  No public API changes; internal-only.

## Unreleased

### Evolve loop — cheap-probe regime gate + compounding strategy scratchpad (roadmap #11, advisory)

Two Browserbase hill-climbing disciplines on the `evolve` executor. Both are advisory-first,
deterministic (pure cores + injected probe runner, no LLM/network), and byte-identical when
their flags are off.

- **Regime gate** (`src/evolve/regime-gate.ts`): before escalating a prescription to the
  expensive 8h autoloop, run an operator-declared cheap deterministic command and classify
  the regime as `deterministic` / `agentic` / `unknown`. A metric a sub-second command
  already satisfies never burns the autoloop budget (the "$24 static-table" anti-pattern).
  Opt-in per playbook via the new optional `Playbook.cheapProbeCommand` field; absent ⇒ no-op.
- **Strategy scratchpad** (`src/evolve/strategy-md.ts`): an append-only, per-playbook markdown
  memo (`z-strategy-<playbookId>.md`) recording what each run tried and how it turned out, fed
  back into the next autoloop program so iterations build on prior attempts instead of starting
  cold.

Env flags (read per-call in `executeEvolution`):

- `SELFHEAL_REGIME_GATE` — advisory regime classification + `[REGIME]` log line. Default ON
  (`!== '0'`). Never alters control flow on its own.
- `SELFHEAL_REGIME_GATE_ENFORCE` — when set (`=== '1'`), a `deterministic` classification
  short-circuits the autoloop entirely. Default OFF.
- `SELFHEAL_STRATEGY_MD` — write/read the compounding scratchpad and inject prior notes into
  the autoloop program. Default ON (`!== '0'`).

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
  - zouroboros-memory@4.1.0
