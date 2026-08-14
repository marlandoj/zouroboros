---
name: design-md-drift-guard
description: >
  Weekly audit + self-healing pipeline. Lints every Projects/*/01-brand/DESIGN.md against the
  Google Labs spec, diffs declared tokens against live site CSS, auto-heals mechanical OKLCH
  approximation drift (opens a PR), and surfaces judgment-call findings (WCAG, missing slots,
  rogue hexes) for human review via email.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# design-md-drift-guard

Keeps the brand's DESIGN.md files and live site code in sync. Every brand that ships a DESIGN.md
implicitly promises that the site's Tailwind/CSS tokens match it — this skill catches the moment
they stop matching, and remediates the safe cases automatically.

## What it checks

For every `Projects/*/01-brand/DESIGN.md`:

1. **Spec lint** — `@google/design.md lint` (errors, warnings, WCAG contrast).
2. **Token drift** — declared hex colors vs hex colors actually used in the configured site CSS.
3. **Orphan tokens** — tokens in DESIGN.md not referenced by the live site (warn).
4. **Rogue tokens** — hex values in site CSS that don't appear in DESIGN.md (warn).

## Pipeline

Two scripts, three modes of action:

```
drift-guard.ts  →  auto-heal.ts  →  orchestrate.ts
   (audit)        (planner+applier)   (PR/email wire)
```

### `drift-guard.ts` — audit only
Lints + diffs. Writes `reports/drift-YYYY-MM-DD.{md,json}`. Read-only.

### `auto-heal.ts` — planner + applier
Reads the latest guard JSON. For each `declaredOnly` finding (a hex declared in DESIGN.md but
absent from the live CSS), checks whether a CSS variable defined as `oklch(...)` renders to
within **5 RGB units** of the spec hex. If so, it's a mechanical encoding drift and the planner
emits an `Edit` that swaps the OKLCH for the literal hex. Findings outside that 5-unit window
become **judgment calls** routed to a human (approximation drift, ambiguous matches between
multiple declared colors, missing slots, WCAG warnings, large rogue-hex sets).

```bash
bun /home/workspace/Skills/design-md-drift-guard/scripts/auto-heal.ts            # dry-run
bun /home/workspace/Skills/design-md-drift-guard/scripts/auto-heal.ts --apply    # write edits
bun /home/workspace/Skills/design-md-drift-guard/scripts/auto-heal.ts --json     # machine-readable
```

Defensive: skips any file using `oklch(from var(...))` derived colors — those are spec-relative
and not safe to mechanically rewrite.

### `orchestrate.ts` — wire heal → PR + email
Per project: runs the planner; if there are mechanical edits, spins up an isolated `git worktree`
under `/tmp` off `origin/<defBranch>`, applies the edits there, commits, pushes, and opens a PR
via `gh`. The user's checkout is never touched — the orchestrator runs cleanly even if their
working tree is dirty or they're on a feature branch. The worktree is torn down in a `finally`
block on every code path. Judgment calls pass through the consensus gate (GLM-5.1, Kimi-K2.6,
MiniMax-M2.5) before being emailed — unanimous-pass findings are suppressed as noise; split or
rejected findings are annotated with model reasoning. Gate errors always fall through (soft fail).

```bash
bun /home/workspace/Skills/design-md-drift-guard/scripts/orchestrate.ts                   # full run
bun /home/workspace/Skills/design-md-drift-guard/scripts/orchestrate.ts --no-pr           # plan + email only
bun /home/workspace/Skills/design-md-drift-guard/scripts/orchestrate.ts --no-consensus    # skip consensus gate
bun /home/workspace/Skills/design-md-drift-guard/scripts/orchestrate.ts --project <slug>
```

### `drift-guard.ts` flags
- `--json` — machine-readable output
- `--fail-on-error` — exit non-zero if any design.md has lint errors or drift (for CI)
- `--project <slug>` — check one project only (e.g. `commerce-a`)

## Tolerance design

| RGB distance | Classification | Action |
|---|---|---|
| ≤ 5 | mechanical encoding drift | auto-heal (PR) |
| 6 – 35 | approximation drift | judgment call (email) |
| > 35 | unrelated; missing slot | judgment call (email) |

The 5-unit window is conservative — only fires for OKLCH approximations that are
perceptually identical to the spec hex. Anything visually distinguishable stays a human call.

## Projects covered

Config lives in `scripts/projects.json`. Each entry maps a DESIGN.md to its site CSS file(s).
Add a new project by adding a record.

## Reports

- `reports/drift-YYYY-MM-DD.{md,json}` — guard output
- `reports/orchestrate-YYYY-MM-DD.md` — orchestrator digest (sent in weekly email)

## Scheduled agent

A weekly agent (Sundays 7am AZ) runs `orchestrate.ts`, captures the digest, and emails it. The
agent's responsibility is execution + delivery; all logic lives in this skill. PRs that land are
reviewed and merged manually.
