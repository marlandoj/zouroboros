---
name: destructive-op-guard
description: Advisory guardrail for destructive/teardown operations. A PostToolUse hook watches Bash commands and, when one matches a teardown pattern (cloud-box/service/IP delete, rm -rf, git push --force, terraform destroy, DROP/dropdb), injects a reminder to run a same-turn workspace reference sweep for the removed identifier. Includes sweep-refs.sh to grep the workspace and classify each hit as live-config vs log/doc. Closes the gap where DIRECT (non-swarm) destructive ops route through zero gates.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
allowed-tools: Bash
---

# destructive-op-guard

Mechanical companion to the `verify-references-against-ground-truth` discipline. It exists because DIRECT (non-swarm) destructive ops — e.g. `hcloud server delete zouroboros-annex` — bypass the swarm "gap-audit loop" entirely (that loop only runs for SWARM-classified tasks), so nothing reminds you to confirm no live config still points at the removed resource.

## Components

### 1. PostToolUse advisory hook — `scripts/post-destructive-sweep-hook.sh`
Wired in `/root/.claude/settings.json` under `PostToolUse` with matcher `Bash`. Fail-open, never blocks, always exits 0.

- Reads the PostToolUse event JSON on stdin.
- Fast pre-filter on the raw payload; the benign case exits in microseconds so the hook is cheap on every Bash call.
- On a genuinely destructive pattern, emits `hookSpecificOutput.additionalContext` reminding you to sweep the workspace for the removed identifier before declaring "no orphaned resources".

Patterns watched: `hcloud <resource> delete`, `rm -r`/`rm -f`/`rm -rf`, `git push … --force`/`-f`, `terraform destroy`, `DROP TABLE|DATABASE|SCHEMA`, `dropdb`, `delete_user_service`.

### 2. Reference sweep — `scripts/sweep-refs.sh <identifier> [<identifier2> ...]`
After a teardown, greps `/home/workspace` for each removed identifier and classifies every hit:
- `[LIVE]` config (`.json`/`.mcp.json`/`.env`/`.service`/`.yml`/`.tf`) — a live dependency, **fix**.
- `[code]` (`.ts`/`.js`/`.sh`/`.py`) — could be a live caller **or** reprovision-path source, **review**.
- `[log]`/`[doc]` — historical, **leave**.

Exit 1 when any config/code hit needs review, 0 when clean. Example:
```
bash Skills/destructive-op-guard/scripts/sweep-refs.sh 203.0.113.10 <resource-id> old-box-name
```

## Rollback
Remove the `Bash`-matcher block from `PostToolUse` in `/root/.claude/settings.json`. The hook is advisory only — removing it changes nothing about tool execution.
