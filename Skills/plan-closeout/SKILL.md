---
name: plan-closeout
description: |
  Mechanized Definition of Done for an implementation plan. Runs four gates
  over a change set and emits one consolidated pass/fail report: (1) EVAL —
  the deterministic checks (tests/compile/dry-run), a hard gate and the real
  correctness guarantee; (2) GAP AUDIT — a wire-what-you-build scan for
  placeholder/stub markers and declared-but-unreferenced functions/exports
  (advisory); (3) CONSENSUS — frontier-model review per changed source file via
  the consensus-gate (advisory; mine the findings, not the verdict); (4)
  COMPLEXITY — single-axis over-engineering review per changed file via
  ponytail-review (advisory ONLY, never gates). Use at the end of every plan so
  closeout does not depend on remembering to do it.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: 1.1.0
  last_updated: 2026-06-17
  depends_on: >
    consensus-gate (Skills/consensus-gate/scripts/consensus-gate.ts);
    ponytail-review (Skills/ponytail-review/scripts/ponytail-review.ts)
---

# Plan Closeout

A single command that runs the **Definition of Done** for a finished plan and
prints one report. It exists so the closeout (eval + gap audit + consensus +
complexity) is mechanized rather than dependent on the agent remembering each
gate.

## Philosophy (read before trusting the output)

The four gates are **not** equal:

1. **EVAL is the guarantee.** The deterministic checks a change declares —
   unit tests, `py_compile`/`tsc`, A/B parity, an end-to-end dry run — are the
   real correctness signal. This is the only **hard gate**: if any eval command
   exits non-zero, the closeout fails (exit 1).
2. **GAP AUDIT is advisory.** It catches the common wire-what-you-build misses:
   stub/placeholder markers and top-level functions/exports that nothing
   references. Some flagged exports are intentional public APIs or future hooks
   — confirm each, don't blindly delete.
3. **CONSENSUS is advisory — mine the findings, not the verdict.** The panel is
   degraded by design (HF models often fail to return parseable JSON and
   abstain; the mechanical arbiter false-flags syntax on some inputs). An
   `ESCALATE` usually just means the panel degraded; a `REJECT` is a prompt to
   look, not a veto. Resolve substantive findings; ignore infra/format noise.
4. **COMPLEXITY is advisory ONLY — suggestions, never failures.** A single-model
   `ponytail-review` pass per changed file hunts one axis: over-engineering
   (reinvented stdlib, dead flexibility, speculative abstractions). It is
   **silent on bugs and security by design**, so it complements CONSENSUS, never
   replaces it. It **never** affects the exit code — not even under `--strict`.
   One model call per file (~⅓ the cost of the 3-model consensus pass). Cut what
   is genuine, ignore the rest.

So the target is **"all deterministic checks pass + every substantive consensus
finding resolved"** — never "100% green from the gate." COMPLEXITY suggestions
are a bonus cleanup list, not part of the bar.

## Usage

```
python3 Skills/plan-closeout/scripts/closeout.py [options]
```

The change set defaults to your uncommitted work (git status, incl. untracked).
Override or narrow it with `--file` (repeatable) or extend it with `--base`.

Key options:

- `--file PATH`        Explicit file in the change set (repeatable). If given,
                       only these are audited/reviewed.
- `--base REF`         Also include files in `git diff REF...HEAD`.
- `--eval "CMD"`       A deterministic check (repeatable). **Hard gate.**
- `--manifest J.json`  `{ "eval": [...], "criteria": "...", "files": [...],
                       "consensus": true|false, "complexity": true|false }` —
                       declare the checks once.
- `--criteria STR`     Consensus review criteria (default
                       `correctness,security,wiring`).
- `--no-consensus`     Skip the consensus phase (fast/offline).
- `--no-arbiter`       Drop the mechanical arbiter rung.
- `--consensus-cap N`  Max files sent to consensus (default 5; cost guard).
- `--no-complexity`    Skip the complexity (ponytail-review) phase.
- `--complexity-cap N` Max files sent to complexity review (default 5; cost guard).
- `--strict`           Also exit non-zero (2) if the **gap audit or consensus**
                       flags. COMPLEXITY is excluded — it never gates.
- `--json`             Emit the report as JSON instead of text.
- `--arm "LABEL"`      Mark a plan active (write the `PLAN_ACTIVE` sentinel) and
                       exit. The Stop hook then blocks conclusion until cleared.
- `--disarm`           Clear the sentinel without running gates (abandon a plan).

### Typical closeout

```
python3 Skills/plan-closeout/scripts/closeout.py \
  --file path/to/changed.ts \
  --eval "bun test path/to/test.ts" \
  --eval "bun build path/to/changed.ts --target=bun --outfile=/dev/null"
```

### Exit codes

| code | meaning |
|------|---------|
| 0    | closeout OK — eval passed (advisory gap/consensus/complexity findings may still exist) |
| 1    | EVAL failed (a declared check did not pass) — hard gate |
| 2    | `--strict` and the gap audit or consensus flagged (complexity never gates) |
| 64   | usage / configuration error (not a git repo, empty change set, bad manifest) |

## Enforcement (the Stop hook)

The skill no longer relies on the agent *remembering* to close out. Two harness
hooks make it mechanical, keyed on the `/home/workspace/.closeout/PLAN_ACTIVE`
sentinel:

1. **`PostToolUse` (matcher `ExitPlanMode`)** — `closeout-planarm-hook.sh` arms
   the sentinel when a plan is approved, labelling it from the plan's first line.
2. **`Stop`** — `closeout-stop-hook.sh` refuses to let the session conclude while
   `PLAN_ACTIVE` exists, emitting a `block` with the run command. The
   `stop_hook_active` guard makes it nudge once rather than trap a loop.

The sentinel is cleared **only** by a closeout run whose deterministic `--eval`
gate passed (a no-eval run leaves it set, so it can't be bypassed). For informal
work that never entered plan mode, arm it by hand with `--arm`. To walk away from
a plan without closing out, `--disarm`. State lives under `.closeout/`
(git-ignored). Wire the hooks in `~/.claude/settings.json`:

```json
"Stop": [{ "matcher": "", "hooks": [{ "type": "command",
  "command": "bash /home/workspace/Skills/plan-closeout/scripts/closeout-stop-hook.sh" }] }],
"PostToolUse": [{ "matcher": "ExitPlanMode", "hooks": [{ "type": "command",
  "command": "bash /home/workspace/Skills/plan-closeout/scripts/closeout-planarm-hook.sh" }] }]
```

## Notes

- On a large/dirty working tree, pass `--file` explicitly — the git-derived
  change set walks all untracked files and can be slow.
- The reference corpus for orphan detection is built once from tracked +
  untracked-not-ignored source files (`.ts/.tsx/.js/.mjs/.py/.sh`), then reused.
- Tests: `python3 Skills/plan-closeout/scripts/test-closeout.py` (24 cases,
  covers consensus-output parsing, eval gate semantics, gap audit over a
  temp-repo fixture, complexity-output parsing + advisory wiring, and the
  plan-active sentinel lifecycle).
- The consensus phase shells out to `consensus-gate.ts` via `bun`; without an
  API key the gate returns mock verdicts (still useful as a dry run).
- The complexity phase shells out to `ponytail-review.ts` via `bun` (provider
  chain `SYNTHETIC_NEW_API_KEY` → `/zo/ask`). With no provider key it reports a
  per-file skip note and contributes nothing — it can never break a closeout.
