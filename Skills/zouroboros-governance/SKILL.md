---
name: zouroboros-governance
description: Constitutional governance for Zouroboros self-modification. Verifies the canonical manifesto and constitution, enforces fail-closed preflight and promotion policy, records hash-chained verdicts, and surfaces consensus dissent for operator review.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  recommendation: R2 — Dissent Report from Consensus Gate
  source: Projects/zouroboros-governance-safety/PROJECT_PLAN.md
---

# Zouroboros Governance

External governance layer for Zouroboros, per `Projects/zouroboros-governance-safety/PROJECT_PLAN.md`.

## Governing authority

The repository documents are authoritative:

- `zouroboros/ZOUROBOROS.md` defines what Zouroboros is.
- `zouroboros/CONSTITUTION.md` defines the ten laws governing self-modification.

The top-level workspace files are symlinks to these canonical copies. Every change to scheduling,
routing, memory, prompts, gates, or governance must use `scripts/constitution-gate.ts` and fail
closed if the gate or governing documents are unavailable.

## What's shipped

### R2 — Dissent Report from Consensus Gate (Q2 2026)

The consensus gate at `Skills/consensus-gate/scripts/consensus-gate.ts` now records structured dissent
(`{model_id, verdict, grounds, evidence}` per claim) alongside the existing scalar confidence. Three surfaces
expose this for operator review:

1. **CLI**: `bun Skills/consensus-gate/scripts/consensus-gate.ts dissent --since 7d [--json]`
2. **Observatory panel**: `https://marlandoj.zo.space/zouroboros/health` (private) — Consensus Dissent section
3. **API**: `https://marlandoj.zo.space/api/consensus-dissent?since=30d&limit=5`
4. **Weekly digest** (this skill): `scripts/dissent-digest.ts` — sends a Monday-morning email summary

## Scripts

### `scripts/constitution-gate.ts`

Deterministic, fail-closed enforcement of Articles I-X. `verify-docs` checks canonical document
presence, structure, and workspace-entry-point drift. `check` validates a JSON change envelope
and records its `ALLOW` or `BLOCK` verdict in the hash-chained governance audit log.

```bash
bun Skills/zouroboros-governance/scripts/constitution-gate.ts verify-docs
bun Skills/zouroboros-governance/scripts/constitution-gate.ts check --stdin --phase preflight
bun Skills/zouroboros-governance/scripts/constitution-gate.ts check --stdin --phase promotion
```

Promotion additionally requires mechanical, held-out, consensus, and regression-free evidence.

### `scripts/dissent-digest.ts`

Builds a weekly HTML digest of dissent events (split verdicts OR confidence < threshold) and either prints it
to stdout (default) or emails it via the Zo `send_email_to_user` plumbing.

```bash
# Preview HTML to stdout (no email)
bun Skills/zouroboros-governance/scripts/dissent-digest.ts --since 7d

# Send the digest (uses /api/zo-ask to dispatch send_email_to_user)
bun Skills/zouroboros-governance/scripts/dissent-digest.ts --since 7d --send

# Skip send when the prior week was quiet (default behavior with --send)
bun Skills/zouroboros-governance/scripts/dissent-digest.ts --since 7d --send --skip-if-empty
```

Flags:

- `--since <spec>` — time window (e.g., `7d`, `14d`). Default `7d`.
- `--min-confidence <float>` — include passing verdicts whose mean confidence is below this. Default `0.65`.
- `--limit <N>` — max events to surface in the email body. Default `15`.
- `--send` — actually email the digest (otherwise print to stdout).
- `--skip-if-empty` — when paired with `--send`, do nothing if the window had zero qualifying events.

Reads `~/.zouroboros/consensus-gate.json` directly — no new env vars required. The companion scheduled agent
runs this with `--send --skip-if-empty` every Monday morning.

## Current boundaries

- Governance is enforced at wired self-modification entry points; it is not a kernel-level syscall interceptor.
- Bypass signatures remain operator assertions rather than public-key signatures.

## Operating contract

- **Scope-restricted** — the governance persona cannot dispatch mutating tools; the skill only reads governing
  inputs and appends verdicts to its audit log.
- **Soft fail** — if the consensus-gate log is missing or malformed, the digest emits a stub and never throws.
- **Hard fail for self-modification** — constitutional check failure or evaluator unavailability blocks execution.
- **Cost ceiling** — zero per-invocation cost; reads a local JSON log and (when sending) issues one
  `send_email_to_user` dispatch via the Zo API.
