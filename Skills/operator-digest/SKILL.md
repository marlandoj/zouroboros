---
name: operator-digest
description: Weekly plain-language briefing of what the Zouroboros loop did on its own — autonomous changes, model health, and the short list of items that actually need the operator's judgment. Read-only.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: "1.0.0"
  category: zouroboros-infrastructure
---

## Operator Digest

A weekly, human-facing summary of the Zouroboros self-improvement loop's autonomous activity.

### Problem

The loop runs unattended: self-heal (introspect → prescribe → evolve), the model healer, the
consensus gate, the curiosity explorer. Each writes structured JSON to the data dir. On their
own those files are operator-hostile blobs. As the operator steps back and lets loops close
without supervision, the risk is **comprehension debt** — the system keeps changing itself and
the operator loses the thread of what changed, why, and where their judgment is still required.

### Solution

`digest.ts` reads the loop's on-disk state for a time window (read-only — it never mutates loop
state) and renders ONE briefing: what changed and why, what the verification layer is watching,
the verified autonomy ledger, and the short list of things that genuinely need a human. It emits
a markdown file, a styled HTML email body, a PDF attachment, and a JSON manifest on stdout for
the scheduled agent.

### Usage

```bash
# Default: last 7 days, data dir from $ZOUROBOROS_DATA_DIR or /root/.zouroboros
bun Skills/operator-digest/scripts/digest.ts

# Custom window / paths
bun Skills/operator-digest/scripts/digest.ts --days 14 --out /tmp/digest --no-pdf
bun Skills/operator-digest/scripts/digest.ts --since 2026-06-01 --data-dir /root/.zouroboros
bun Skills/operator-digest/scripts/digest.ts \
  --prompt-metrics /root/.zouroboros/confirmation-prompt-events.jsonl \
  --graph-db /root/.zouroboros/factory/state/graphrag-relational/falkordblite
```

### Data sources (all optional — a missing file degrades to "nothing this week", never a crash)

| File | What it contributes |
|------|---------------------|
| `evolution-history.json`   | autonomous interventions: playbook, metric, delta, kept/reverted |
| `intervention-ledger.json` | per-intervention state deltas + anti-Goodhart drift flags |
| `chronicle.json` + `chronicle-votes.json` | curiosity proposals; accepted votes = escalations |
| `healer-state.json`        | model failovers + per-model health probes |
| `reputation.json`          | consensus voter reputation (agreement / vendor-error rates) |
| `agent-model-healer/assets/fallback-chain.json` | friendly model labels + retired-model list |
| canonical governance ledger + detached anchor | T0 counts, T1 actions, T2 denials, anomalies, approval failures |
| `confirmation-prompt-events.jsonl` | matched before/after confirmation-prompt counts from the production permission UI |
| embedded GraphRAG query | bounded read-only governance relationship evidence |

The prompt source uses schema version 1 with `source`, `cohort_id`, `workload_id`,
`workload_hash`, `phase`, `confirmation_prompts`, `action_count`, and `policy_version`.
Only one exact before/after pair with the same workload hash and action count contributes to a
reduction metric. One-sided, duplicate, mismatched, malformed, or mixed-source records are
reported and excluded. A missing source produces no reduction claim.

The runtime-adapter inventory is versioned under
`Skills/zouroboros-governance/config/runtime-adapters.json`. Only the Claude pre-tool adapter is
supported in this release, and only in shadow or hermetic-canary mode. Codex, Zo-native, MCP,
and unknown runtimes remain explicitly unsupported; their records are visible and cannot be
treated as governed execution evidence.

The graph consumer invokes the installed `graphrag-relational` query entrypoint with a fixed
read-only Cypher statement and a limit of five. Missing code, missing data, query failure, invalid
output, or an empty graph degrades visibly and contributes no graph-derived evidence.

### Severity model

The subject line and accent are driven by a deliberate three-level scheme. The point is to
reserve the alarm for the loop actually misbehaving, so the operator can trust a `❌` to mean
"look now" rather than crying wolf on routine self-correction.

- **`❌ action`** — an anti-Goodhart drift flag tripped: a change improved its *visible* metric
  while the *hidden* held-out set moved against it (possible metric-gaming). This is the only
  legacy loop case where the loop itself is suspected of misbehaving. An invalid canonical
  governance ledger or an unapproved T2 allow is also action-level.
- **`⚠️ review`** — items need human judgment but the loop is behaving: curiosity proposals the
  operator accepted (awaiting escalation), **live** models failing their last health probe,
  unsupported runtime calls, or missing prompt/graph evidence.
- **`✅ clear`** — nothing waiting.

Two deliberate exclusions keep the signal honest:
- **Reverts are informational, not alarms.** A rolled-back change is the loop self-correcting —
  reported under "What changed" with a ↩️ tag, never escalated to `❌`.
- **Retired models are filtered out.** A stale failing probe for a model the healer deliberately
  removed from the catalog (any `_removed*` block in `fallback-chain.json`) is expected fallout
  of the removal, not an operator concern. Unhealthy lines also carry the probe age so a stale
  probe can't silently overstate urgency.

### Manifest (stdout)

```json
{ "status": "action|review|clear", "subject": "…", "summary": "…", "windowLabel": "…",
  "mdPath": "…", "htmlPath": "…", "pdfPath": "… or null", "changedCount": 0,
  "needsJudgment": 0, "driftDetected": false, "reverts": 0, "healthOk": true }
```

### Files

- `scripts/digest.ts` — the generator (read-only; no dependencies beyond Bun + a PDF renderer)
- `scripts/governance-evidence.ts` — fail-closed ledger, prompt, adapter, and graph collector
- `scripts/governance-evidence.test.ts` — integrity, matching, adapter, graph, and CLI regressions
- Outputs land in `<data-dir>/operator-digest/operator-digest-<YYYY-MM-DD>.{md,html,pdf}`

### Scheduled agent

A weekly `[ZBR]` Zo agent runs the script, parses the manifest, and emails the operator the
HTML body with the PDF attached (subject = `manifest.subject`, which carries the status emoji).
The script does the work; the agent only renders + delivers. PDF rendering falls back through
`wkhtmltopdf → weasyprint → chromium`; if all fail, the email still sends with the HTML body.
