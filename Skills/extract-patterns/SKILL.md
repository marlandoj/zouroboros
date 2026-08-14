---
name: extract-patterns
description: Gate session-derived behavioral patterns before writing them to durable memory. Use at session close or when maintaining the ZOU-452 extraction hook to admit only project-specific, recurring, non-obvious trigger-to-action patterns and reject ordinary best practices or one-off observations.
---

# Extract Patterns

Noise-free session pattern gate (ZOU-452). A binary discipline check at session
stop: extract a behavioral pattern ONLY if it is all four of project-specific,
repeatedly applicable, non-obvious, and trigger→action. Otherwise write nothing
— "No new patterns to extract." — so trivial sessions add zero memory noise.

Adapted from the ECC repo `extract-patterns` Kiro hook (MIT).

## How it works

- `scripts/extract-patterns-hook.sh` is registered in
  `/home/workspace/.claude/settings.json` for **Stop** and **SessionEnd**.
- **Stop**: once per session, after the transcript crosses
  `EXTRACT_PATTERNS_MIN_LINES` (default 40) transcript lines, the hook blocks
  once with the four-criteria review prompt. The agent either extracts
  (trigger→action + domain) or replies "No new patterns to extract." and
  writes nothing.
- **SessionEnd**: never blocks; back-fills the decision log so every session
  has exactly one outcome line (`no-review` for sub-threshold sessions,
  `prompted-unresolved` if the agent never answered the gate).
- **Routing**: if `.zo/instincts/instincts.yaml` exists (ZOU-451
  instinct-harvester), patterns go there via `observer.ts add`; otherwise they
  append to `Projects/lessons-learned.md`.

## Recognized inputs

The gate reads the following sources when evaluating whether a pattern
qualifies for graduation to `instincts.yaml` or `lessons-learned.md`:

- **Session transcript** — the primary input (the Stop hook prompt).
- **`visual-failures.jsonl`** (SIL-13) — per-project visual verification
  mismatch log. Each line: `{timestamp, route, diffs, model, seedTaskId}`.
  A visual failure mode with ≥2 confirmed occurrences (same route or same
  diff pattern across different routes) is eligible for graduation. The
  gate applies the same 4-criteria test; qualifying patterns route to
  `instincts.yaml` with a `visual` domain tag.
- **`classifier-blocks.jsonl`** (SIL-14) — append-only ledger of classifier
  soft-blocks + fallbacks from `Skills/classifier-fallback/`. Each line:
  `{timestamp, provider, model, task_class, domain, detection{block_type,confidence,...}, fallback{action,...}}`.
  A recurring soft-block signature (same `provider`+`block_type`, or the same
  `domain` repeatedly hitting fallback) with ≥2 confirmed occurrences is
  eligible for graduation — e.g. "Anthropic refuses security-research on
  distillation-adjacent queries" → an instinct that pre-routes the task.
  Qualifying patterns route to `instincts.yaml` with a `classifier` domain tag.
  Refuse-by-design blocks (distillation) are logged but NEVER graduate to a
  route-around instinct — the block is intentional.

## Decision log

`/dev/shm/extract-patterns.log`, one line per decision:

```
2026-07-03T03:00:00Z session=<id> decision=prompted lines=87
2026-07-03T03:01:12Z session=<id> decision=extracted domain=software-factory
2026-07-03T03:04:00Z session=<id> decision=none
2026-07-03T03:05:00Z session=<id> decision=no-review reason=below-threshold
```

(tmpfs — resets on host reboot; extracted patterns themselves persist in the
stores, only the decision audit trail is ephemeral.)

## Operator controls

- Kill switch: `touch /home/workspace/.claude/extract-patterns.off` (or env
  `EXTRACT_PATTERNS_OFF=1`). Remove the file to re-enable.
- Threshold: `EXTRACT_PATTERNS_MIN_LINES` (default 40).
- The hook fails open on any error and never traps a session in a loop
  (`stop_hook_active` guard + one `.prompted` sentinel per session in
  `/dev/shm/extract-patterns/`).

## Test

`bash scripts/selftest.sh` — exercises threshold skip, prompt-once, loop
guard, SessionEnd back-fill, and kill switch against fixture stdin JSON.
