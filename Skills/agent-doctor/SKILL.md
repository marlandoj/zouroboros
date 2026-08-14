---
name: agent-doctor
description: Agent fleet health utilities — path preflight checker and auto-remediating weekly doctor with apply mode.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

## doctor.ts

Auto-remediating fleet doctor. Audits all scheduled agents for cost waste, zombies, duplicates, and hygiene drift.

```bash
bun Skills/agent-doctor/scripts/doctor.ts            # report-only (diagnose)
bun Skills/agent-doctor/scripts/doctor.ts apply      # auto-apply safe fixes
bun Skills/agent-doctor/scripts/doctor.ts summary    # one-line summary
bun Skills/agent-doctor/scripts/doctor.ts zombies    # single check
```

Exit codes: `0` = clean, `2` = findings present (or changes applied), `1` = apply error.

Auto-applied (safe): zombie deactivation (no next_run), cost-fitness model downgrade, delivery-method silence.
Manual review only: duplicates, instruction-hygiene, frequency-waste, persona-fitness, schedule-collision, instruction-length, output-delta.

Safety excludes (never mutated): `01a6df7e-6bd4-4772-bfe4-d04404106b8b` (Agent Doctor self), `14cfe6a6-105e-4160-bf95-a93e95f871a0` (Model Healer).

Requires `assets/model-tiers.json` in the same skill directory.

## preflight-paths.ts

Verifies that all given file paths exist on disk. Exits 0 if all OK, exits 1 with `BROKEN PATH: <path>` lines for any missing files.

```bash
bun Skills/agent-doctor/scripts/preflight-paths.ts /path/to/file1.ts /path/to/file2.ts
```
