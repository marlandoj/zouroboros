# Packaging — Milestone 0 Decision Doc

**Status:** RATIFIED — operator sign-off 2026-07-04. Operator and agent treat this as the source of truth for the "Make Zouroboros Packageable" initiative (Linear project `make-zouroboros-packageable`).
**Date:** 2026-07-04 (ratified 2026-07-04)
**Scope:** Decides the coupling boundary, distribution unit, package manager, and MVP bundle. Nothing in M1–M4 is well-defined until these are fixed.

---

## Decisions

### D1 — Distribution unit: npm-primary, CLI-driven bootstrap
Ship the runtime primitives as **npm packages** under an `@zouroboros/*` scope (versioned via the existing `.changeset/`). Skills, personas, and the memory-gate hook are laid down by **`zouroboros init`**, not copied by a separate script.
**Why:** npm gives versioning, dependency resolution, and changesets that a skill-copy approach lacks; the CLI gives the Zo-native skill/hook placement that npm alone cannot. One canonical path: `npm i -g @zouroboros/cli` → `zouroboros init`.
**Consequence:** the standalone `Zouroboros/install.sh` (a Bun skills-copier shipping a curated 7-skill subset) is **retired** — its logic is absorbed into `zouroboros init`. *(Resolves the two-rival-artifacts blindspot.)*

### D2 — Package manager: pnpm is canonical
`pnpm` (already declared `packageManager: pnpm@8.15.0`) is the one build tool. **Delete `bun.lock`**; pin pnpm via corepack. Bun remains only as an optional *runtime* for executing skill scripts (`bun script.ts`), never as a package manager. M4 clean-room installs the **published tarball via `npm i -g`** (publishing is manager-agnostic).
**Why:** the repo currently carries `bun.lock` + `pnpm-lock.yaml`, declares pnpm, builds with `pnpm -r`, and `install.sh` assumes Bun — a fresh box resolves nondeterministically.

### D3 — MVP "core" bundle: CLI + 2 packages + a curated skill set
| In MVP | Deferred to a later bundle |
|---|---|
| `@zouroboros/cli` (entry: `init`, `doctor`, `migrate`) | `swarm` (78 hardcodes, heaviest Zo coupling) |
| `core` (paths/config/migrations — the foundation) | `rag` (needs Python + FlashRank model download + Qdrant) |
| `memory` (gate-injected memory + recall) | `bench`, `mcp-memory`, `persona-creator`, `workflow` |
| Skills: `consensus-gate`, `agent-model-healer`, `build-watchdog`, `spec-first-interview`, `three-stage-eval`, `zouroboros-{introspect,prescribe,evolve}` | `selfheal` advanced scoring (advisory, v2) |

**Why:** bounded target for the quickstart. `rag` is deferred because it carries a real Python + downloaded-reranker prereq (friction for a stranger). `swarm` carries the most path debt and is adapter-heavy. The MVP is exactly the Linear "candidate first bundle": consensus gate + healers/watchdogs + memory + skill scaffolding.
**Blocker surfaced:** the MVP skills are **scattered across four homes** — `zouroboros/Skills/` (has `consensus-gate`, `agent-model-healer`), workspace `Skills/` (`build-watchdog`), `Zouroboros/` public repo (`introspect/prescribe/evolve`), and `packages/workflow/docs/` (`spec-first-interview`, `three-stage-eval`). M2 must declare **one canonical home per skill** and relocate; the relocation inventory is an M2 input, not a given.

### D4 — Coupling boundary: portable vs. Zo-required matrix
Every primitive is classified **Portable** (runs anywhere with Node + keys), **Adapter-required** (needs a thin interface with a Zo adapter + a no-op/generic fallback), or **Deferred** (Zo-only, out of MVP).

| Primitive | Class | Coupling / adapter needed |
|---|---|---|
| `core` (paths, config, migrations) | Portable | `getWorkspaceRoot()` reads env; no external dep |
| `memory` (SQLite FTS + embeddings) | Portable* | *Degraded mode: FTS-only when no embedding key. Needs `.env` OpenAI key for the vector arm |
| memory-gate **daemon** (`:7820`) | Portable | HTTP server; port already env-overridable (`MIMIR_GATE_URL`) |
| memory-gate **hook** (`UserPromptSubmit`) | **Adapter-required** | Harness-specific: Zo/Claude-Code writes `settings.json`; other hosts need a documented "call gate before prompt" shim. **This is the hardest deliverable — see D6.** |
| `consensus-gate` | **Adapter-required** | LLM transport: `/zo/ask` on Zo → direct provider SDK off-Zo |
| `agent-model-healer`, `build-watchdog` | **Adapter-required** | `Notifier` (SMS/email → console) + `Scheduler` (Zo automations → cron/manual) |
| `swarm` | Deferred | `AgentRegistry` + transport + gate; most coupled |
| personas / `persona-creator` | Portable (templates)* | *`set_active_persona` is Zo-only → no-op adapter off-Zo; ship UUIDs as externalized config |
| `selfheal` scoring | Portable* | *Deterministic scoring portable; prescribe/evolve loop uses the LLM transport adapter |

**Three interfaces to build in M2:** `Notifier`, `Scheduler`, and a transport/`AgentRegistry` — each with a Zo adapter and a generic no-op/console fallback.

### D5 — Scrub scope includes git-tracked fixtures, not just runtime
The scrub step must scan **committed files**, not only prevent shipping a runtime `memory.db`. Confirmed in-tree offenders carrying `marlandoj` + persona UUIDs: `packages/bench/data/agent-fleet-roster.json` and `packages/bench/data/rag-only/seed*.json`.
**Rule:** each package uses a `files` allowlist / `.npmignore` excluding `data/` fixtures with operator facts, or those fixtures are sanitized to synthetic. *(M4's "no data mount" gives false assurance — the leak is committed, not mounted.)*

### D6 — Validation is dual-lane
M4 must run **two** lanes, both green = done:
- **Lane A — container:** Docker `npm i -g` the tarball → `doctor` → assert green. Validates CLI + packages + libs.
- **Lane B — real harness:** a fresh Zo box (via the new ZOU-414 provisioning + ZOU-415 `hetzner-exec` bridge) that asserts the `UserPromptSubmit` hook **actually fires and the gate injects context**. Validates the daemon+hook — the part Lane A structurally cannot reach.
**Why:** a bare container's `doctor` reports green while the memory-gate integration — the thing that makes Zouroboros *Zouroboros* — is never exercised.

### D7 — M1 exit condition widened + re-baselined
Exit grep covers the whole shipped tree: **`grep -rn /home/workspace packages/ Skills/ cli/` returns zero.** Real baseline (not the "85" in the plan): **190 in `packages/`, 288 across `packages/ + Skills/ + cli/`.** Per-package debt for M1 sub-slicing:

| swarm 78 · selfheal 26 · memory 23 · bench 19 · rag 12 · core 9 · persona-creator 8 · workflow 6 · mcp-memory 5 · personas 2 · agents 2 |
|---|

`packages/core/src/paths.ts` (`getWorkspaceRoot()`) exists and is partially adopted → this is *finish the migration*, not greenfield.

### D8 — IP boundary & release target *(operator sign-off required)*
- **Public MVP:** core, memory, CLI, consensus-gate, healers, watchdogs, foundational skills.
- **Private / never-ship:** confidential client business seeds (already out of scope), the Software Factory internals (SF-001…013 — a separate product), instincts-store contents, benchmark data with operator facts.
- **Release target:** published tarball / private access for clean-room first → public `@zouroboros/*` npm scope once M4 is green.

---

## Ratification checklist (operator)
- [x] D1 — retire `Zouroboros/install.sh`, absorb into `zouroboros init`
- [x] D2 — pnpm canonical, delete `bun.lock`
- [x] D3 — MVP = CLI + core + memory + the 8 curated skills; defer swarm/rag/bench/etc.
- [x] D8 — confirm public vs. private boundary and initial release target (private tarball → public npm)

*Ratified 2026-07-04. M1 mechanical tickets cleared to become `factory-ready`.*

*On ratification: M1 mechanical tickets (per-package path migration, `.env.example`, ID externalization, scrub) become `factory-ready`; M2 (adapters + daemon/hook) goes through spec-interview first.*
