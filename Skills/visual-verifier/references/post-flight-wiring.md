# Post-Flight Stage 2 Wiring — Visual Verification

## When the station runs

The visual verifier station runs during **post-flight Stage 2** (acceptance
criteria verification) for any deliverable flagged `visual: true` in the seed.

### Seed task flag

Add `visual: true` to any seed task that produces a rendered output (UI route,
zo.space page, site page, dashboard, landing page):

```yaml
tasks:
  - id: T1
    title: "Build the pricing page"
    visual: true          # ← triggers the visual verifier station
    acceptance: "Page renders with the project palette, hero section, and CTA."
```

Tasks without the flag (or with `visual: false` / absent) skip the station —
byte-identical to the pre-SIL-13 post-flight eval. Backward-compatible.

### Post-flight procedure (agent-side)

When running post-flight Stage 2 and a task has `visual: true`:

1. **After text ACs pass**, capture a screenshot:
   ```bash
   bun Skills/visual-verifier/scripts/station.ts \
     --url "http://localhost:3099/<route>" \
     --criteria "<task acceptance text>" \
     --design-md "<path/to/DESIGN.md>" \
     --label "<task-id>" \
     --output-dir "Projects/<project>/visual-state/"
   ```
2. **Read the exit code**: 0 = visual match, 1 = mismatch (rework needed).
3. **On mismatch**: the station writes `visual-diff-<label>.json` with a
   structured diff (issue, criterion violated, severity). Feed this diff
   back to the maker subagent for the next iteration. The maker does NOT
   self-declare done on visual tasks — the verifier is the exit condition.
4. **On match**: mark the task visually verified. Proceed.

### What the station checks

The verifier reads the **screenshot image** (not the code) and compares
against three references:

- **(a)** Seed acceptance criteria (passed via `--criteria`)
- **(b)** Project `DESIGN.md` tokens (passed via `--design-md`) — palette,
  typography, spacing, border-radius, etc.
- **(c)** Prior screenshot (if one exists in the visual-state directory) —
  catches regressions from a previous iteration.

### ≠Author constraint

The verifier model is provably ≠ the author model. The station uses the
`excludeAuthor` / `sameModel` helpers from `Skills/consensus-gate/scripts/
reviewer-independence.ts` (P0-2, zou-cg-p0-2) to enforce this. If the
default verifier model matches the author model, the station logs a warning
and falls back to an alternate model.

### Panel mode (future)

`VISUAL_VERIFIER_PANEL=1` activates multi-verifier panel mode: N verifiers
each read the screenshot, merged via `applyTrustAndRecall` (deterministic-first
+ recall-bias). Default OFF — single verifier is the minimum viable station.
