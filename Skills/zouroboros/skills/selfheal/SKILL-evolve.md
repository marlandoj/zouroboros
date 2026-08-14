---
name: zouroboros-evolve
description: >
  Evolution engine for the Zouroboros self-enhancement pipeline. Takes a prescription
  (seed + playbook) and executes the improvement: either via autoloop (file-targeting
  playbooks) or via script execution (procedural playbooks). Measures before/after,
  keeps improvements, reverts regressions, and stores results as episodes.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: "1.0.0"
  phase: "Zouroboros Phase 3 — Evolution"
---

# Zouroboros Evolve

Executes a prescribed improvement and validates the result.

## Usage

```bash
bun Skills/zouroboros/skills/selfheal/scripts/evolve.ts --prescription <path> [--dry-run] [--skip-governor]
```

### Flags

| Flag | Description |
|------|-------------|
| `--prescription, -p` | Path to prescription JSON from prescribe.ts |
| `--dry-run` | Show what would be executed without running |
| `--skip-governor` | Override governor flags (requires explicit intent) |

### Execution Modes

1. **Autoloop mode** — When prescription has a program.md, delegates to autoloop.ts
2. **Script mode** — When prescription has no target file, executes the playbook directly via a generated remediation script

### Safety

- Pre-flight: run introspect to capture baseline metrics
- Post-flight: run introspect again to measure delta
- Any metric regression > 2% triggers automatic revert
- All changes logged as memory episodes

## Maintenance hooks

After every evolve run, the main pipeline invokes a set of maintenance subcommands that piggyback on the existing schedule rather than running on their own.

### `feedback-mine` — user-correction clustering (W3 of dreaming-gap-fillers)

Clusters `feedback_*` memories that accumulate passively from the memory-gate (every user correction stored as a feedback memory) and surfaces rule-consolidation candidates when ≥3 corrections share a `failure_class` within 90 days.

```bash
bun Skills/zouroboros-evolve/scripts/feedback-mine.ts [--json] [--threshold 3] [--window 90]
```

| Flag | Description |
|------|-------------|
| `--json` | Output candidates as JSON instead of formatted text |
| `--threshold N` | Min cluster size to surface (default: 3) |
| `--window N` | Lookback window in days (default: 90) |

- Reuses existing `failure_class` taxonomy + `reflections.json` storage — no new schema
- Wired into `evolve.ts main()` as a maintenance step; runs daily on the 5:15 AM Phoenix Reflexion cadence
- Surface-only — proposed Rule body ≤ 500 chars (Zo Rules budget); user confirms before any Rule edit
- Reflexion email gains a "Rule consolidation candidates" section when candidates exist

See `docs/architecture/dreaming-gap-fillers.md` for the cross-wave coverage map.
