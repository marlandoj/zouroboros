---
name: agent-introspect
description: Weekly self-audit of the Zo skill, identity, persona-registry, and script-health surfaces. Walks Skills/*/scripts/, probes each script's --help under a bounded retry budget, checks identity files, and compares caller-supplied persona observations without mutating platform state. Use when running or maintaining the "[SYS] Audit Skills & Personas" scheduled agent, investigating introspection findings, or changing the SKIP_HEALTH skip list.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# Agent Introspect

Hardened, version-controlled audit that replaces the formerly-inline Python
heredoc inside the **[SYS] Audit Skills & Personas** scheduled agent
(`automation_id 1f8e4dbc-d879-4e2b-bc45-3cfae24d4333`, weekly Sun 14:00 Phoenix).

The script preserves the inline audit's checks and adds structural skill
validation plus operational safety the inline block lacked.

## Run it

```bash
# Normal run (writes report + atomic status file, takes a concurrency lock)
python3 Skills/agent-introspect/scripts/introspect.py

# Compat mode (retries=0, budget=3600) — used for A/B parity vs the old inline audit
python3 Skills/agent-introspect/scripts/introspect.py --compat --findings-only

# Tests (skip_health parity + fail-closed config validation)
python3 Skills/agent-introspect/scripts/test_introspect.py

# Pure persona drift check (the caller obtains the snapshot)
python3 Skills/agent-introspect/scripts/persona_audit.py \
  --registry packages/swarm/assets/persona-registry.json \
  --snapshot /path/to/caller-supplied-personas.json \
  --model-catalog Skills/consensus-gate/assets/byok-registry.json

python3 Skills/agent-introspect/scripts/test_persona_audit.py
```

## What it checks

1. **Skills** — every top-level `Skills/*/SKILL.md` for YAML frontmatter,
   required `name` and `description`, lowercase hyphen-case naming, directory
   alignment, and runnable script presence. Also flags a top-level `scripts/`
   directory whose skill has no `SKILL.md`.
2. **Identity** — `AGENTS.md` present; `IDENTITY/*.md` not stale (>30 days).
3. **Script health** — probes each `Skills/*/scripts/` file with `--help`
   (`.ts→bun`, `.py→python3`, `.sh→bash`). Flags exit codes outside `{0,1}` and
   timeouts. Files named in `config.json:skip_health` are skipped.
4. **Persona registry** — compares a caller-supplied `list_personas` snapshot
   against `packages/swarm/assets/persona-registry.json` by immutable platform
   ID. It reports missing/live-only records, name/model/scope drift, duplicate
   IDs or slugs, malformed input, and model IDs absent from the BYOK catalog.

The persona checker has no API client and no apply path. It only reads the
three explicit files and prints one JSON result. Exit `0` means clean, `2`
means drift, and `1` means malformed or unavailable input. Its output includes
registered/live counts plus deterministic SHA-256 hashes for audit provenance.
Entries marked `redacted: true` retain their stable platform ID while omitting a
sensitive public name. The audit suppresses only name comparison for those
entries; model, scopes, presence, uniqueness, and provenance remain enforced.

## Architecture Hotspots (advisory, not a check)

The report carries an additive **Architecture Hotspots** appendix sourced from
the codebase-memory graph (`DeusData/codebase-memory-mcp`). For each of
`home-workspace-packages` and `home-workspace-Skills` it lists the top fan-in
functions (widest regression blast radius) and the lowest-cohesion Leiden
clusters (fuzziest module seams — refactor candidates). This is **context, not a
finding**: it never adds to the findings count, never changes the exit code, and
a missing/timed-out graph degrades to a one-line note. Because it lives outside
the findings set, compat parity (`--compat --findings-only`) is unaffected.

Knobs are module constants in `introspect.py` (`ARCH_BIN`, `ARCH_PROJECTS`,
`ARCH_TIMEOUT_S`, `ARCH_TOP_HOTSPOTS`, `ARCH_LOW_COHESION`) — deliberately not in
`config.json`, so the schema version and fail-closed key guard stay frozen.
Note: advisory content rides the **email rule** unchanged — a zero-finding week
writes the report to disk but does not email it.

## Contract (how the agent consumes it)

- The agent **deletes** `Reports/Introspections/.introspect-status.json` before
  invoking the script, then **requires** the file to exist afterward. Absence ==
  ERROR (proves the status is from the current run — no time-window heuristic).
- Exit codes: `0` OK · `1` ERROR · `3` PARTIAL · `4` lock-contention. PARTIAL and
  ERROR are non-zero, so a consumer reading only the exit code never mistakes
  them for success.
- Status file keys: `status, exit_code, findings, report, partial_reason,
  unprobed, unprobeable_ext, error, ran_at`.
- **Email rule:** email on ERROR (always), PARTIAL (always), OK only if
  `findings > 0`.

## config.json

All keys are validated; any failure is a fail-closed ERROR (no defaults, no
fail-open). `version` is checked against `EXPECTED_CONFIG_VERSION` in
`introspect.py` — config and script ship in the same commit, so a desync is a
loud error, not silent misbehavior.

| key | meaning | range |
|---|---|---|
| `version` | config schema version | must equal 1 |
| `probe_timeout_s` | per-attempt `--help` timeout | 1..120 |
| `retries` | extra attempts on timeout only | 0..3 |
| `audit_budget_s` | global monotonic deadline | 60..3600 |
| `max_timeouts` | timeout events before retries disable | 1..100 |
| `skip_health` | filenames skipped by the health probe | list, no dups |

**Changing `skip_health`** means editing both `config.json` and the
`FROZEN_SKIP_HEALTH` snapshot in `test_introspect.py` — the parity test fails
otherwise. This is intentional: the skip list cannot drift silently.

## Hardening notes

- Probe child stdout/stderr is captured into variables, never echoed to the
  audit's own stdout — a probed script cannot spoof the status.
- Retry is timeout-only; one timeout event per script even under retries.
- Interpreter preflight (`shutil.which`): a missing `bun/python3/bash` becomes a
  finding, never a silent pass.
- Runnable-but-unprobeable files (`.mjs/.js`) are counted (`unprobeable_ext`) and
  listed under "skipped (no probe strategy)".
- No secrets are read, passed on argv, or logged — `--help` probes need none.
