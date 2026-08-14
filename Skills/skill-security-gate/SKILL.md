---
name: skill-security-gate
description: Security governance gate for AI agent skills, backed by NVIDIA SkillSpector. Statically scans a skill (local path, directory, zip, or Git URL) for 65 vulnerability patterns across 16 categories (prompt injection, data exfiltration, privilege escalation, supply chain, excessive agency, tool/MCP misuse, dangerous code via AST, YARA signatures) and returns a 0-100 risk score with a SAFE / REVIEW / DO_NOT_INSTALL recommendation. Use BEFORE adopting any third-party skill, and for the periodic baseline scan of the Skills/ directory.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
allowed-tools: Bash
---

# Skill Security Gate

Pre-adoption + periodic security scanner for agent skills. Wraps the
**NVIDIA SkillSpector** CLI (installed via `uv tool`, Apache-2.0).

## When to use

1. **Pre-adoption gate** — run before installing/adopting ANY third-party skill
   (Git URL, zip, or local clone). This is the primary, highest-value use.
2. **Baseline sweep** — periodic recursive scan of `Skills/` to catch drift.

## Commands

```bash
# Pre-adoption: scan a third-party skill before installing it
bash Skills/skill-security-gate/scripts/gate.sh <path-or-git-url>

# Baseline: recursive scan of the whole Skills/ tree (dated JSON report)
bash Skills/skill-security-gate/scripts/gate.sh --skills
```

Reports are written to `Integrations/skillspector/reports/`.

## Reading the score — IMPORTANT calibration note

SkillSpector's static (`--no-llm`) heuristics are tuned to be suspicious of
**untrusted** skills. They flag legitimate, expected behavior as risky:

- `subprocess.run(...)` / shell calls -> "Dangerous Code Execution"
- outbound `fetch`/`curl`/API calls -> "Data Exfiltration"
- file writes + tool use -> "Excessive Agency" / "Tool Misuse"

Because of this, **first-party trusted skills in this repo routinely score
CRITICAL** (e.g. `consensus-gate`, `zo-swarm-orchestrator`) — that is noise,
not a real verdict. Treat the gate as a signal for **new / third-party** skills:

- **SAFE / LOW (0-29)** -> adopt.
- **REVIEW / MEDIUM-HIGH (30-69)** -> read the flagged findings; adopt only if
  each is explained by intended behavior.
- **DO_NOT_INSTALL / CRITICAL (70-100)** on an *unknown third-party* skill ->
  do not adopt without manual line-by-line review.

For high-stakes third-party adoptions, re-run WITHOUT `--no-llm` and an
`ANTHROPIC_API_KEY` set for semantic confirmation (see `gate.sh --llm`).

## Supply-chain checks (deterministic, advisory)

The SkillSpector wrapper above lints skill **code**. The supply-chain gate covers
three surfaces it does NOT see — all deterministic (no LLM, no network by default):

```bash
# All three checks over the repo (advisory: prints + writes a report, exits 0)
bun Skills/skill-security-gate/scripts/supply-chain/gate.ts

bun .../gate.ts --actions     # GitHub Action SHA-pin audit only
bun .../gate.ts --mcp         # MCP injection scan + inventory/policy only
bun .../gate.ts --strict      # exit 1 on any critical (or SUPPLY_CHAIN_ENFORCE=1)
bun .../gate.ts --resolve     # resolve mutable tags -> commit SHA via git ls-remote (network)
```

1. **action-pin-audit** — flags every `uses:` in `.github/workflows/*.yml` pinned to
   a mutable tag/branch instead of a 40-hex commit SHA (the TJ-Actions re-point
   vector) **[critical]**. `--resolve` fills in the exact SHA to pin to. Local `./`
   and `docker://` refs are skipped. Audit only — it never rewrites workflow files.
2. **mcp-inject-scan** — scans MCP tool **descriptions** and **local server source**
   for smuggled directives: imperative override ("ignore previous instructions") and
   exfil instructions **[critical]**, hidden/zero-width unicode **[warning]**,
   secret-keyword / long base64 in a description **[info]**. Calibrated so that
   normal env-reads / fetch calls in server *source* are NOT flagged (FP guard).
3. **mcp-inventory + policy** — enumerates every `.mcp.json` server (handles both the
   `mcpServers` and `servers` keys), classifies local-source vs third-party
   (uvx/npx/remote-url), and checks each against `mcp-policy.json`
   (`allow`/`restrict`/`approve`/`block`; unlisted ⇒ `approve`). block ⇒ critical,
   restrict ⇒ warning, approve ⇒ info, allow ⇒ silent.

**Posture:** advisory-first (exits 0 even with criticals) so it is safe in CI as a
visible signal; `--strict` / `SUPPLY_CHAIN_ENFORCE=1` is the operator opt-in. Reports
land in `Integrations/skill-supply-chain/reports/`. Edit `mcp-policy.json` to record
allow/block decisions per server.

## Underlying tool

- Binary: `skillspector` (on PATH at `/root/.local/bin`; gate.sh prepends it).
- Source: `Integrations/skillspector/` (NVIDIA/SkillSpector, Apache-2.0).
- Reinstall/update: `uv tool install --python 3.12 /home/workspace/Integrations/skillspector`
- Supply-chain checks: `scripts/supply-chain/` (Bun/TS, pure cores + `gate.ts` CLI; `bun test` in that dir).
