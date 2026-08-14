# Zouroboros MVP Skills — canonical publishable home

This directory is the **single source of truth** for the MVP skill set that
ships inside `@zouroboros/cli`. Each subdirectory is a self-contained skill
(`SKILL.md` + `references/`/`assets/` docs + `scripts/`).

`zouroboros init` lays these skills down into `$ZOUROBOROS_SKILLS_DIR`
(default `<workspace>/Skills`, fallback `~/Skills`), and
`zouroboros skills install` re-installs them on demand. Both read from this
bundle — no monorepo package sources or external repos are required at install
time.

## Skills

| Skill | Purpose |
| --- | --- |
| `consensus-gate` | Multi-model consensus review with escalation valve |
| `three-stage-eval` | Mechanical / semantic / consensus evaluation pipeline |
| `zouroboros-introspect` | 7-metric health scorecard for the Zo ecosystem |
| `zouroboros-prescribe` | Auto-generate improvement prescriptions from a scorecard |
| `zouroboros-evolve` | Execute prescriptions with regression detection |
| `agent-model-healer` | Detect unhealthy agent models and fail over fallback chains |
| `build-watchdog` | Monitor active builds and alert on regressions |
| `spec-first-interview` | Socratic interview & seed specification generator |

## Provenance

These were consolidated (ZOU-466) from four scattered homes — `Skills/`,
`packages/workflow/docs/`, the `Zouroboros/` public repo, and the mirror — into
this one bundle. To change a skill, edit it here; this is the copy that
publishes and that `init` installs.
