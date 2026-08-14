# Seat Health Runbook — Production MoA

Scope: the six-hour seat-health probe (`scripts/seat-health-probe.ts`) that maintains
`~/.zouroboros/provider-resilience-health.json` for the seats persisted in
`~/.zouroboros/lineup.json`. The retired three-reviewer-plus-adjudicator shadow
profile (`lineup.consensus.json`) is **not** production routing evidence — never
probe it here (operator decision D1, 2026-08-01).

## Probe lanes

| Lane | What it proves | Source of truth |
|---|---|---|
| Transport | Provider endpoint is reachable (route health) | `moa-runtime.callMoaModel` / `provider-resilience` |
| Capability | Seat returns a parseable verdict inside the generation budget | `Projects/zouroboros-software-factory/scripts/consensus-capability.ts`, which shells out to `provider-smoke-probe.ts` |

## Probe calibration — read before reporting a seat "unreachable"

- **A capability timeout is NOT an outage.** The capability lane enforces a
  generation deadline (`GEN_TIMEOUT_MS` in `provider-smoke-probe.ts`). A seat
  that fails *only* the capability lane with a `timed out after Nms` error —
  while transport and review lanes pass — is slow, not down. Report it as
  "capability timeout," never "unreachable."
- **Generation budget is per-provider.** Default 30 s. Override map:
  `GEN_TIMEOUT_OVERRIDES_MS` in `provider-smoke-probe.ts`. Current overrides:
  `zo-byok` → 90 s (operator-approved 2026-08-06).
- **Why zo-byok needs 90 s:** subscription BYOK seats (Codex GPT 5.6 Sol,
  Claude Code Sonnet 4.6) route through Zo's `/zo/ask` layer; transport alone
  measures ~23–24 s time-to-first-response. A generation call on top of that
  crosses a 30 s ceiling. Interactive use of these seats has no such
  constraint, so "it works in chat" and "probe timed out" are both true.
- **Incident 2026-08-06:** 30 s ceiling misclassified 2/4 seats as unusable;
  both were healthy. Fixed by the per-provider override above. Verification
  probe after the fix: all seats capable.

## Escalation

- All lanes failing for a seat → real provider-side issue (auth, quota,
  routing). Alert.
- Capability-only timeout after the 90 s override → investigate latency before
  alerting; consider whether the seat's model got slower upstream.
- Probe script, lineup, or output contract missing/malformed → alert with exact
  stderr; do not attempt automated repair.
