# production-ready

<p align="center">
  <img src="https://marlandoj.zo.space/images/blog/production-ready-hero.png" alt="Production Ready — dark cybersecurity hero banner with amber shield and terminal aesthetic" width="100%" />
</p>

> A repeatable, evidence-based launch-readiness audit for AI-generated web apps and SaaS products.

**Inspired by the [Vibeshield Protocol](https://x.com/dagreatgawdnyc) — extended with executable tooling, deeper checks, copy-paste remediation prompts, and a CI-friendly output format.**

## Core rule

> Do not assume AI-generated code is safe because it runs.

A passing test suite, a green CI badge, and a clean local browser tab tell you the code *executes*. They tell you nothing about whether it will leak secrets, accept arbitrary user input, expose admin routes, drain your wallet to a billing-loop, or fail WCAG.

This audit surfaces those gaps before launch — 17 domains, real tooling, real verdicts.

## Quick start

```bash
git clone <this-repo>
cd production-ready
bun install

# Audit a local repo
bun scripts/audit.ts --repo /path/to/repo

# Audit a deployed URL (adds DAST, performance, a11y)
bun scripts/audit.ts --url https://example.com

# Full audit
bun scripts/audit.ts --repo /path/to/repo --url https://staging.example.com --godmode
```

Or copy into a Skills directory and run inline via Claude Code / Zo Computer.

## Requirements

| Need | Why |
|------|-----|
| **Bun** | `bun install` + runtime for audit scripts |
| **`.env` or env var** | `SYNTHETIC_NEW_API_KEY` — required for consensus triage (`--consensus` flag). The triage layer routes findings through three independent LLM vendors via [synthetic.new](https://synthetic.new/?referral=FGlN8dcd7mPmhgo). New users get a **$10 credit** when signing up with the referral link. |
| *(Optional)* Security tools | See Required tools below — the skill auto-detects what is present and falls back to heuristics for anything missing. You do not need every tool. |

## What it checks (17 domains)

```
 1. Legal & Data Handling    10. Performance & Reliability
 2. Secrets & Credentials    11. Payments & Webhooks
 3. Authentication & Authz   12. File Upload Safety
 4. API Route Safety         13. Database & Data Access
 5. OWASP Baseline           14. AI-Code Failure Modes
 6. Abuse, Cost & Rate Limit 15. Browser Testing (Playwright)
 7. Frontend Exposure        16. Concurrency & State Integrity
 8. Logging & Monitoring     17. Visual Consistency
 9. Accessibility
```

For each, the skill runs real static analysis (gitleaks, semgrep, osv-scanner, trivy), DAST (nuclei, ZAP), performance (Lighthouse), and accessibility (axe-core, pa11y) tools when present — and falls back to scoped heuristic scanners when they aren't.

## Outputs

```
production-ready-audit/
├── findings.json          # machine-readable, full report
├── report.md              # human-readable
├── report.html            # branded, shareable
├── verdict.json           # single-decision summary
└── prompts/               # copy-paste fix prompts for coding agents
    ├── INDEX.md
    └── <finding-id>.md
```

## Launch verdicts

| Verdict | Trigger | Exit code |
|---------|---------|-----------|
| 🟢 **Launch-Ready** | 0 critical, 0 high, ≤ 3 medium | 0 |
| 🟡 **Launch with Monitoring** | 0 critical, 0 high, but mediums to track | 1 |
| 🟠 **Private Beta Only** | 0 critical, 1+ high — invite-gated launch OK | 2 |
| 🔴 **Do Not Launch** | Any critical / hard blocker | 3 |

Hard blockers are non-negotiable: exposed live secrets, BOLA across tenants, unverified payment webhooks, JWT alg=none, `if False:` around a security check, etc.

## Triage (FP cut)

```bash
bun scripts/audit.ts --repo . --triage              # deterministic reproduce pass
bun scripts/audit.ts --repo . --triage --consensus  # + 2-vendor LLM adjudication
```

Heuristic regex findings get a second look — match in a comment, regex literal, or doc string is dropped; `--consensus` routes survivors through `synthetic.new` for a 3-vendor quorum vote (gpt-oss-120b + Llama-3.3-70B + Qwen3-Coder-480B by default). 2-of-3 quorum decides; split downgrades one tier + flags for review; fewer than 2 responses keeps original severity. Tool-sourced findings (gitleaks/semgrep/osv-scanner) are never triaged. Verified self-audit FP cut: 7 high → 0 high. Verified bad-app preservation: 4 of 5 critical hard blockers preserved at full severity; webhook-signature was correctly flagged for review.

<p align="center">
  <img src="https://marlandoj.zo.space/images/blog/production-ready-infographic-v2.png" alt="Production Ready — complete audit pipeline from input to verdict to outputs" width="100%" />
  <br/>
  <em>From repo/live URL → 15-domain scan → triage/consensus → launch verdict → multiple output formats</em>
</p>

## Godmode

```bash
bun scripts/audit.ts --repo . --url https://staging.foo.app --godmode
```

1. Runs every check, including ones that need a live URL
2. Applies experimental AI-code heuristics (higher recall, more false positives)
3. Generates a remediation prompt for **every** finding, not just critical/high
4. Opens the HTML report in your browser when done
5. Drops a `LAUNCH_CHECKLIST.md` in the audited repo root for stakeholder sign-off

## Required tools (install for full audit)

```bash
# Most checks
brew install gitleaks osv-scanner semgrep
npm i -g lighthouse pa11y @axe-core/cli

# Optional — DAST against live URL
brew install nuclei
docker pull ghcr.io/zaproxy/zaproxy:stable

# Optional — container / IaC
brew install trivy
```

The audit auto-detects which tools are present and reports `tooling.json` accordingly. Missing tools mean checks fall back to repo-scoped heuristics, not failure.

## CI integration

Drop the included GitHub Actions workflow into your repo:

```bash
cp .github/workflows/production-ready.yml /path/to/your/repo/.github/workflows/
```

It runs on every PR, comments findings inline, and fails the build on **Do Not Launch**.

## Documentation

- [`SKILL.md`](./SKILL.md) — full skill manifest, every command, every flag
- [`references/tool-reference.md`](./references/tool-reference.md) — every CLI tool with install + invocation
- [`references/owasp-top-10.md`](./references/owasp-top-10.md) — Web / API / LLM Top 10 quick refs
- [`references/ai-failure-modes.md`](./references/ai-failure-modes.md) — cataloged AI-generated code antipatterns
- [`references/production-checklist.md`](./references/production-checklist.md) — Google SRE + AWS WAF + GitLab merged
- [`references/compliance.md`](./references/compliance.md) — SOC 2 / GDPR / CCPA / PCI-DSS / HIPAA starters
- [`references/audit-config-schema.md`](./references/audit-config-schema.md) — full `audit.config.json` schema

## Why this exists

Veracode 2025: **45% of AI-generated code shipped vulnerabilities**, with error-handling gaps at roughly **2× the rate of human-written code**. The default failure mode of AI-assisted development is "looks like it works, ships with footguns."

Production-readiness audits were already a SRE / security best practice — this skill bundles them into a single repeatable run with a definitive verdict and machine-readable remediation prompts you can feed back into your coding agent.

## License

MIT. See [`LICENSE`](./LICENSE).

## Credits

Inspired by [DaGreat GawdNYC's Vibeshield Protocol](https://x.com/dagreatgawdnyc). Re-implemented with executable scanners, deeper checks, and a tighter feedback loop with coding agents.
