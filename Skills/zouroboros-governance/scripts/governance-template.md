# GOVERNANCE.md — Canonical Template

> Drop this file at the root of any new skill (`Skills/<slug>/GOVERNANCE.md`)
> before merging. The `capability-ethics.ts` rollup will pick it up.

---

## Skill: `<slug>`

### Capability statement
What this skill *does* in plain language. Include any actions it can take on
behalf of the operator (file writes, external API calls, message sends, etc.).

### Blast radius
Mark one:

- [ ] **Tiny** — read-only, local only
- [ ] **Small** — local writes, no external calls
- [ ] **Medium** — external calls, but to systems the operator owns
- [ ] **Large** — external calls to systems the operator does not fully control
- [ ] **Public** — produces content visible to others (publish, send, post)

### Ethics review
Answer all four. Be specific. "N/A — read-only" is acceptable when honest.

1. **Whose data does this touch?** (operator only / third parties / both)
2. **What goes wrong if this misfires?** (data loss / wrong action / public embarrassment / financial loss / nothing)
3. **Is there a reversible-action contract?** (yes / no, and why)
4. **Does this need consensus-gate or governance review before acting?** (yes / no, and rationale)

### Failure modes considered
List the 2–3 ways this skill could plausibly fail and what each looks like
from the operator's view. The point is to show you actually thought about it
— not to enumerate every imaginable edge case.

### Out of scope
What this skill explicitly will not do. Acts as a contract for future
contributors.

### Audit hooks
- [ ] Logs to local file (path: `<path>`)
- [ ] Logs to `~/.zouroboros/governance-audit.log` via `governance.ts`
- [ ] No audit (justify above; only valid for tiny-blast-radius skills)

---

> Once this file exists in a skill directory, the capability-ethics rollup
> at `Skills/zouroboros-governance/scripts/capability-ethics.ts` will count
> it toward the project-wide ratio. The ratio is surfaced on the observatory.
