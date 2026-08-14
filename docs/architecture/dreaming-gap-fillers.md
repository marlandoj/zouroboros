# Dreaming Gap Fillers

*Shipped 2026-05-10 · Lineage: Anthropic Dreaming pattern (2026-05-06) → Jeff-Kazzee/dreaming community port → Zouroboros gap analysis*

## Purpose

Anthropic's Dreaming pattern (introspective overnight passes that surface drift, idle skills, and broken assumptions) inspired a community Skill (`Jeff-Kazzee/dreaming`) that duplicated ~60% of capabilities Zouroboros already has — but flagged **four real coverage gaps** that no existing surface watched.

This feature closes those four gaps by **extending existing skills**, not by adding a sibling Dreaming skill. Net new infrastructure: zero — no new schedules, no new sqlite files, no new tables.

## Coverage map

| Gap | Already-covered by Zouroboros | New extension |
|---|---|---|
| Idle Skills, drifted Rules, stale Personas | `agent-introspect` (97 personas, hard metrics) | — |
| Visual style drift | `design-md-drift-guard` (OKLCH math + auto-PR + WCAG) | — |
| Workflow → Skill promotion | `skill-crystallization-v1` (HMAC approval + $1/day cap + 14d GC) | — |
| Broken Automations | `agent-doctor` (apply mode, 11 checks) | — |
| **Cross-project content bleed** | none | **W1: bleed-scan** |
| **Personal-detail intrusion in public copy** | none | **W2: pii-leak-scan** |
| **User-correction memory clustering** | none | **W3: feedback-mine** |
| **Quiet hosted Sites** | none | **W4: quiet-site** |

## Wave architecture

### W1 — bleed-scan (extends `agent-introspect`)

Detects when content (paragraphs, copy, persona-specific phrasing) leaks from one project's folder into another's outputs before it reaches a public surface.

- **Algorithm**: Chunk text outputs under `Projects/*/`, compute minhash signatures, flag near-duplicate spans where source and destination projects differ
- **Threshold**: Jaccard ≥ 0.85 (initial; tune after first 20-finding sample)
- **Whitelist**: Shared canon (e.g. `COMMERCE_SKU_CANON.md`), templates, attribution snippets
- **Cadence**: Piggybacks `agent-introspect`'s weekly run — no new schedule
- **Storage**: Reuses `shared-facts.db` (no new sqlite file)
- **Surface**: Introspect's existing email report channel
- **Cost**: Local CPU minhash, zero LLM cost

Script: `Skills/agent-introspect/scripts/bleed-scan.py`

### W2 — pii-leak-scan (extends `design-md-drift-guard`)

Catches first-person voice, name, location aliases, and registered phone/email slipping into copy that should read generic (customer social posts, vendor outreach, blog drafts, public site copy).

- **Config**: `Skills/design-md-drift-guard/config/pii.json` — configurable identifier list and allow/deny path globs
- **Scope-aware**: Skips `Notes/`, `Backups/`, `Skills/*/SKILL.md` (where personal voice is fine); flags `Projects/*/copy/`, `Projects/*/posts/`, customer drafts
- **Cadence**: Piggybacks drift-guard's weekly orchestrate cycle
- **Surface**: Findings flow into the existing email orchestrator alongside DESIGN.md drift findings
- **Posture**: Surface-only; no auto-edit, no auto-PR (unlike OKLCH drift, this requires judgment)

Script: `Skills/design-md-drift-guard/scripts/pii-leak-scan.ts`

### W3 — feedback-mine (extends `zouroboros-evolve`)

Clusters `feedback_*` memories that accumulate passively (memory-gate writes them on every user correction) but no surface reads. When ≥3 corrections share a class within 90 days, emits a "rule consolidation candidate."

- **Approach**: Wired into the existing Reflexion loop's main pipeline
- **Reuse**: Existing `failure_class` taxonomy + `reflections.json` storage (no new schema)
- **Threshold**: ≥3 reflections in same `failure_class` within 90 days → consolidation candidate (new sub-type, not new table)
- **Cadence**: Reflexion's existing daily 5:15 AM Phoenix agent (`1fbbd615`)
- **Output**: Existing Reflexion email channel gains a "Rule consolidation candidates" section
- **Posture**: Surface-only; user confirms before any Rule edit (zero auto-apply)
- **Cost**: ≈ $0.05/run (clustering + proposal drafting on `gpt-4o-mini`)

Script: `Skills/zouroboros-evolve/scripts/feedback-mine.ts`

### W4 — quiet-site (extends `agent-doctor`)

Audits Zo published sites and services that haven't been touched, aren't reachable, or no longer serve a purpose.

- **Source**: `list_user_services` + `list_space_routes`
- **Signals**: last-update timestamp, reachability ping (5s timeout, single retry), last-visit estimate from Loki
- **Classification**: dead / quiet / healthy / unknown
- **Quiet rule**: zero requests in 30d + last-deploy > 90d → quiet; missing logs → unknown
- **Cadence**: Doctor's existing weekly run
- **Posture**: Surface-only; reuses doctor's typed-confirmation `apply` mode gating if user later opts in
- **Sentinel**: `Skills/agent-doctor/config/quiet-site.enabled` — gated off by default after live test (7 quiet, 1 unknown)

Script: `Skills/agent-doctor/scripts/doctor.ts` (12th check inserted after `checkOutputDelta`)

## Cost model

| Wave | LLM cost / run | Schedule | Cadence cost |
|---|---|---|---|
| W1 bleed-scan | $0 (local minhash) | weekly | $0/yr |
| W2 pii-leak-scan | ~$0.01 | weekly | $0.52/yr |
| W3 feedback-mine | ~$0.05 | daily | $18.25/yr (mostly skipped — only fires when ≥3 same-class feedback) |
| W4 quiet-site | $0 (network + Loki) | weekly | $0/yr |

Total marginal cost: ≈ $0.50/year (most runs short-circuit when no findings).

## Non-goals

- Do **not** install `Jeff-Kazzee/dreaming` skill verbatim — duplicates ~60% of existing capability
- Do **not** rebuild visual-style drift detection (drift-guard wins on OKLCH math + auto-PR)
- Do **not** rebuild idle-skill / persona-drift detection (introspect wins on 97-persona hard metrics)
- Do **not** rebuild workflow→skill promotion (crystallization-v1 wins on HMAC approval + cost cap)
- Do **not** rebuild zombie-agent detection (doctor wins on 11 checks + apply mode)
- Do **not** add sibling skills, schedules, or sqlite files

## References

- `Notes/jeff-kazzee-dreaming-evaluation-2026-05-10.md` — full evaluation of upstream skill
- `Notes/anthropic-dream-vs-zouroboros-2026-05-09.md` — comparison with Anthropic's official `/dream`
- `Projects/zouroboros-dreaming-gap-fillers/SCOPE.md` — original project scope
