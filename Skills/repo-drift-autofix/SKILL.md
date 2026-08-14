---
name: repo-drift-autofix
description: Autonomous repo drift remediation — runs quality gates, clusters uncommitted files by branch scope, auto-commits in-scope clusters, pushes, and creates a draft GitHub PR. Called by the [SYS] Audit Repo Drift automation after drift thresholds are exceeded. Read-only when --dry-run is passed.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

## Usage

```bash
bun /home/workspace/Skills/repo-drift-autofix/scripts/autofix.ts \
  --repo /path/to/repo \
  [--dry-run]
```

**Output:** JSON written to stdout. Audit log appended to `/home/.z/repo-drift-autofix.log`.

## What it does

1. **Branch guards** — refuses autoloop/* and protected branches (main, master, develop)
2. **Clusters** uncommitted files by top-2-directory (`packages/swarm`, `Skills/consensus-gate`, etc.)
3. **Scope-matches** clusters against the branch name tokens (e.g. `feat/swarm-t3-refactor` → tokens: `swarm`, `t3`, `refactor`)
4. **Safety scan** — blocks if any in-scope file exceeds 5MB or matches a secret pattern
5. **Quality gate** — runs `pnpm/bun tsc --noEmit` with a 120s timeout; aborts if it fails
6. **Auto-commits** each in-scope cluster with a template commit message
7. **Pushes** the branch to origin
8. **Creates a draft PR** via `gh pr create --draft`; skips if a PR already exists for the branch
9. **Outliers** (files whose directory doesn't match the branch scope) are left uncommitted and surfaced in the PR body and email report

## Safety guarantees

- Never commits to autoloop/* or protected branches
- Never auto-merges — only creates draft PRs
- Aborts if TypeScript fails
- Blocks secrets and large files
- All actions appended to `/home/.z/repo-drift-autofix.log` for audit

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success (or nothing to do) |
| 1    | Unrecoverable error (missing repo path, etc.) |
