---
name: build-watchdog
description: Change-gated progress monitor for long-running builds. A deterministic process scans canonical PROGRESS.md files and sends one consolidated email only when a material milestone, blocker, recovery, scope change, stall, or completion occurs. Use to monitor multi-step work without recurring model sessions or notification noise.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: "2.0.0"
  category: ops
---

## Build Watchdog

The managed `build-watchdog` process checks current project progress every 30 minutes. Quiet
sweeps are entirely deterministic and make no model call. When one or more material events exist,
the service asks Kimi K2.7-Code to deliver exactly one consolidated operational email, then commits
the new watcher state. A failed delivery leaves state unchanged so the alert can retry.

Per operator directive (2026-08-14), the delivery agent performs a bounded read-only investigation
(referenced PROGRESS.md files plus factory execution state under
`/home/workspace/.runtime/factory-state/v1`) and formats every email with these sections:
Factory Health, Build Status, Bottom Line, Root Cause & Remediation, Raw Digest. Raw error dumps
without diagnosis are not acceptable. The same four-part contract applies to the factory conveyor
agent's SMS and error emails (see the OPERATOR REPORT FORMAT section of automation
`[SYS] Factory Conveyor`, id `7760679f`).

### Progress-file contract

Use GFM task lists and one current status declaration:

```markdown
watchdog: active
status: in_progress

- [x] Completed milestone
- [ ] Pending milestone
- BLOCKED: Actionable reason
```

- `status: in_progress`, `status: blocked`, or `status: complete`; the last declaration wins.
- Blockers must use `BLOCKED: <reason>` or `[BLOCKED] <reason>`. Prose merely mentioning
  "blocked", "failed", or "error" is not treated as a blocker.
- `watchdog: active` watches the file, `watchdog: paused` preserves an intentional wait, and
  `watchdog: off` excludes completed or archival records.
- Files explicitly marked complete are retired after their completion event is acknowledged.

### Event model

The single-file watcher reports `COMPLETE`, `MILESTONE`, `BLOCKER`, `RECOVERY`, `SCOPE`,
`REGRESSION`, `STALL`, `BASELINE`, `MISSING`, `OPTED_OUT`, or `SILENT`.

Scope additions and removals are visible. Completion can reopen cleanly. A known blocker suppresses
redundant stall alerts. The sweep groups all events by severity into one digest.

### Run locally

Single file:

```bash
bun /home/workspace/Skills/build-watchdog/scripts/watchdog.ts \
  --progress /home/workspace/Projects/<name>/PROGRESS.md \
  --label "<Name> build" \
  --stall-min 45
```

All recent projects:

```bash
bun /home/workspace/Skills/build-watchdog/scripts/watchdog-sweep.ts \
  --fresh-hours 24 --stall-min 45 --dry-run
```

Service one-shot:

```bash
bun /home/workspace/Skills/build-watchdog/scripts/watchdog-service.ts --once --dry-run
```

`--dry-run` performs no state mutation. Use `--reset` on the single-file watcher to establish a
new silent baseline.

### Production wiring

- Managed process service: `build-watchdog`.
- Entrypoint: `scripts/watchdog-service.ts --interval-sec 1800`.
- Consumer: the service calls `watchdog-sweep.ts`; only a non-empty digest invokes the configured
  `WATCHDOG_MODEL` and Zo email tool.
- No recurring Zo automation or per-project agent is required.
