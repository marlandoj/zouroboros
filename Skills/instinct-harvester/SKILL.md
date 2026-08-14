---
name: instinct-harvester
description: Store, reinforce, retrieve, prune, and lifecycle-manage confidence-weighted trigger-to-action instincts for Zouroboros. Use when maintaining the behavioral learning layer, adding a pattern that passed the extract-patterns gate, generating domain-aware instinct briefings, or auditing instinct decay and supersession.
---

# Instinct Harvester

Behavioral pattern learning layer (ZOU-451). Stores confidence-weighted
trigger→action patterns ("when doing X in context Y, prefer Z") in
`/home/workspace/.zo/instincts/instincts.yaml` — a layer above the fact-based
memory system, because behavioral patterns compound where facts decay.

Adapted from the ECC repo `skills/continuous-learning-v2/` (MIT).

## Architecture

- **Observer** — the session agent itself, prompted at session stop by the
  extract-patterns gate (ZOU-452, `Skills/extract-patterns/`). When a pattern
  passes the four-criteria gate (project-specific, repeatedly applicable,
  non-obvious, trigger→action), the agent records it via `observer.ts add`.
  Hook-path code stays deterministic: no LLM call, no API-key dependency —
  the agent with the richest session view does the judgment.
- **Store** — `instincts.yaml`: id, trigger, action, domain, confidence,
  source (`session-observation` | `repo-curated` | `daily-synthesis`),
  reinforced_count, last_seen. Corrupt store is snapshotted to
  `*.corrupt-<ts>` before any fail-safe empty read, so writers can't clobber.
- **Dedup/conflict** (`merge.ts`, pure) — key = normalized trigger+domain;
  same-key candidate = reinforcement; higher-confidence entry's fields win
  (equal → existing kept); reinforced_count merges; last_seen bumps.
- **Pruning** (`prune.ts`, pure + CLI) — cap 200, ranked by confidence →
  reinforced_count → last_seen. Runs automatically on every `add`.
- **Session briefing injection** — memory-gate hook (UserPromptSubmit) prints
  an `<instincts>` block: top-5, domain-aware (domains named in the prompt
  rank first). Flag `INSTINCT_INJECT` (default ON); no-op when store absent.
- **Daily reinforcement** — `[ZBR] Synthesize Daily Memory` (1fbbd615) reads
  the store, reports top instincts, and reinforces only patterns with
  concrete evidence in that day's synthesis (advisory; never fails the run).
- **Daily lifecycle** (Phase 1, `lifecycle.ts`) — the maintenance half the
  write path lacks. `merge.ts` only ratchets confidence UP; this adds a
  recency signal (**liveness**, derived from `last_seen`, separate from
  confidence), **protection** for strong/critical instincts, **supersession**
  (the only downward confidence path, driven by an explicit `supersedes`
  marker), and a **blended-score prune** (`confidence · liveness`). Meant to
  run daily inside Memory Pipeline B (`[MEM] Decay Memory`, ce3e493a).
  Advisory-first: writes nothing unless `--apply`. See
  `INSTINCT-LIFECYCLE-SPEC.md` for the full design + Phase 2 (semantic search).

## CLI

```
bun scripts/observer.ts add --trigger T --action A --domain D [--confidence 0.7] [--source session-observation]
bun scripts/observer.ts brief [--top 5] [--context "prompt text"]
bun scripts/observer.ts list [--domain D]
bun scripts/observer.ts stats
bun scripts/observer.ts reinforce --id inst_NNN
bun scripts/prune.ts [--cap 200] [--dry-run]
bun scripts/lifecycle.ts [--apply] [--report PATH] [--half-life 30] [--protect-conf 0.90] [--protect-reinforced 8] [--cap 200] [--today YYYY-MM-DD]
```

Env: `INSTINCT_STORE_PATH` (store override), `INSTINCT_CAP` (default 200),
`INSTINCT_INJECT=0` (disable briefing injection),
`INSTINCT_LIFECYCLE_ENFORCE=1` (equivalent to `lifecycle.ts --apply`).

Optional per-instinct lifecycle markers (all backward-compatible): `critical`
(hard-protect), `supersedes: <id>` (demote the instinct it replaces),
`superseded_by: <id>` (audit stamp written by the lifecycle run).

## Test

`bun scripts/selftest.ts` — 29 deterministic checks (validation, key
normalization, merge/conflict/reinforcement, pruning + ranking, YAML
round-trip on an isolated temp path, briefing selection/rendering).
Never touches the live store: ESM import hoisting means a top-of-file env
assignment does NOT isolate `observer.ts`'s module-init store path — pass
explicit path args instead.

`bun scripts/lifecycle-selftest.ts` — 47 deterministic checks (age/liveness
curve, protection, keep-score, supersession + idempotency, prune with
protection, decay-watch ordering, report rendering). Pure logic, no store I/O.
