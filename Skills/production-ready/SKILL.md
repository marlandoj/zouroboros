---
name: production-ready
description: Production-readiness audit for AI-generated web apps and SaaS products. Runs an 18-domain audit (legal, secrets, auth, API safety, OWASP, abuse/rate-limits, frontend exposure, logging, accessibility, performance, payments, file uploads, database, AI-code failure modes, Playwright browser testing, concurrency/state integrity, visual consistency, SEO/AEO) against a code repo and/or live URL, produces a coverage-aware launch verdict (Do Not Launch / Private Beta Only / Launch with Monitoring / Launch-Ready — an incomplete audit can never be Launch-Ready), and emits machine-readable JSON, human-readable Markdown, and a shareable HTML report — plus copy-paste prompts to feed back into your coding agent for remediation.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: 1.0.0
  protocol: vibeshield-derived
---
# Production Ready

A repeatable, evidence-based launch readiness audit. Inspired by the Vibeshield protocol — extended with executable tooling, deeper checks, copy-paste remediation prompts, and a CI-friendly output format.

## Core rule

**Do not assume AI-generated code is safe because it runs.**

A passing test suite, a green CI badge, and a clean local browser tab tell you the code *executes*. They tell you nothing about whether it will leak secrets, accept arbitrary user input, expose admin routes, drain your wallet to a billing-loop, or fail WCAG. This skill exists to surface those gaps before launch.

## Quick start

```bash
# Audit a local repo (uses installed tools, falls back to heuristic checks)
bun /home/workspace/Skills/production-ready/scripts/audit.ts --repo /path/to/repo

# Audit a deployed URL (adds DAST, performance, a11y, CSP checks)
bun /home/workspace/Skills/production-ready/scripts/audit.ts --url https://example.com

# Both — full audit
bun /home/workspace/Skills/production-ready/scripts/audit.ts \
  --repo /path/to/repo \
  --url https://example.com \
  --out /tmp/audit \
  --format all
```

## Commands

```bash
# Full audit (all 18 domains)
bun scripts/audit.ts [--repo PATH] [--url URL] [--out DIR] [--format json|md|html|all]

# Single domain (any of):
bun scripts/audit.ts --only secrets
bun scripts/audit.ts --only owasp
bun scripts/audit.ts --only accessibility
bun scripts/audit.ts --only performance
bun scripts/audit.ts --only ai-code
# ... etc

# List all domains
bun scripts/audit.ts --list

# Show the launch verdict logic
bun scripts/verdict.ts --explain

# Generate a remediation prompt pack from a previous audit
bun scripts/prompts.ts --audit /tmp/audit/findings.json
```

## The 18 audit domains

| # | Domain | What it checks | Tools used (fallback: heuristic) |
|---|--------|----------------|----------------------------------|
| 1 | **Legal & Data Handling** | Privacy policy, ToS, data retention/deletion/export, third-party sharing disclosures | Manual checklist + repo grep for `privacy`/`gdpr`/`ccpa` |
| 2 | **Secrets & Credential Exposure** | Frontend key leaks, unsafe env vars, exposed tokens, rotation | `gitleaks`, `trufflehog`, repo bundle scan |
| 3 | **Authentication & Authorization** | Server-side auth, ownership checks, role gates, admin protection, session safety | `semgrep` rulesets + auth pattern grep |
| 4 | **API Route Safety** | Input validation, method controls, rate limits, CORS, abuse paths | `semgrep`, route grep, OpenAPI lint |
| 5 | **OWASP Baseline** | XSS, CSRF, SSRF, IDOR, injection, security headers, dependency CVEs | `semgrep` + `osv-scanner` + `nuclei` (if URL) |
| 6 | **Abuse, Cost & Rate Limits** | Throttling, payload caps, bot friction, billing-loop protection | Route grep + middleware detection |
| 7 | **Frontend Exposure** | Bundle leaks, localStorage secrets, sourcemaps, network exposure | Source bundle scan + `gitleaks` on `dist/` |
| 8 | **Logging & Monitoring** | Privacy-safe logs, uptime checks, alerts, audit trails | Logger config grep + PII pattern scan |
| 9 | **Accessibility** | WCAG 2.2 AA — keyboard, labels, contrast, screen-reader, motion | `axe-core` CLI + `pa11y` (if URL) |
| 10 | **Performance & Reliability** | Bundle size, caching, indexes, loading states, backups, timeouts, rollbacks | `lighthouse` (Core Web Vitals) + repo heuristics |
| 11 | **Payments & Webhooks** | Stripe signature verification, idempotency, entitlement logic, secret handling | Stripe pattern grep + webhook handler audit |
| 12 | **File Upload Safety** | Size/type validation, ownership checks, signed URLs, quotas, content sniffing | Upload handler grep |
| 13 | **Database & Data Access** | RLS, tenant scoping, parameterized queries, indexes, audit trails, backups | Schema/query grep + RLS policy check |
| 14 | **AI-Generated Code Failure Modes** | Silenced errors, dead code, fake-passing tests, weakened security, brittle abstractions | Custom heuristic scan (`try: pass`, `assert True`, commented auth) |
| 15 | **Manual Browser Testing** | Sign-in flows, role boundaries, admin paths, mobile UX, protected routes | Generates a manual test checklist tailored to the app |
| 16 | **Concurrency & State Integrity** | Race conditions, transaction isolation, idempotency keys, double-submit, stale-read-after-write | Repo heuristics + concurrency-pattern grep |
| 17 | **Visual Consistency** | Layout drift, color/spacing token adherence, responsive breakage, orphan components | Repo heuristics + snapshot diff (if available) |
| 18 | **SEO / AEO (Search & Answer-Engine Visibility)** | RFC 9309 robots.txt, sitemap reachability, title/meta-description/canonical/hreflang/OG, JSON-LD structured data parity, robots-meta noindex intent, AI-bot policy | `curl` (HTML head + robots/sitemap) + `lighthouse` SEO category (optional) |

## Required inputs

The audit script will use whatever it can find. To get a complete report, provide:

- **App name & purpose** — `--name "FooApp" --purpose "personal finance tracker"`
- **Tech stack** — auto-detected from `package.json`, `pyproject.toml`, `go.mod`, etc.
- **Deployment platform** — auto-detected from `vercel.json`, `netlify.toml`, `Dockerfile`, etc.
- **Database / auth / payment providers** — detected from deps; supplement with `--config audit.config.json`
- **Code repo path** — `--repo`
- **Public or staging URL** — `--url`
- **Special surfaces** — `--has-user-data --has-uploads --has-admin --has-ai --has-payments`

See `references/audit-config-schema.md` for the full optional config file.

## Outputs

Every audit produces, in `--out` (default `./production-ready-audit/`):

- `findings.json` — machine-readable, full finding records
- `report.md` — human-readable report (this is what you ship to stakeholders)
- `report.html` — branded standalone HTML (open in browser, share via zo.pub)
- `verdict.json` — single-decision summary (verdict, blockers, scores)
- `prompts/` — one copy-paste remediation prompt per critical/high finding, formatted for Claude Code / Cursor / Aider

## Launch verdicts

The verdict is the **worst of two gates**: a findings gate (what problems were found) and a coverage gate (did the audit actually look). Run `bun scripts/verdict.ts --explain` for the full model.

Findings gate:

| Verdict | Trigger |
|---------|---------|
| **🟢 Launch-Ready** | 0 critical, 0 high, ≤ maxMedium (default 3, tunable via risk profile) |
| **🟡 Launch with Monitoring** | 0 critical, 0 high, but medium findings present that should be tracked post-launch |
| **🟠 Private Beta Only** | 0 critical, 1+ high findings — invite-gated launch acceptable |
| **🔴 Do Not Launch** | Any critical (hard blocker) finding |

Coverage gate (caps the verdict — a clean-but-blind scan is NOT a pass):

| Cap | Trigger |
|-----|---------|
| **🟠 Private Beta Only** | ≥ 2 core scanners missing (gitleaks/semgrep/osv-scanner), or a security-critical domain errored |
| **🟡 Launch with Monitoring** | 1 core scanner missing, partial domain coverage, no `--url`, or critical manual checks not signed off (`--manual-verified`) |

## Hard blockers (always critical)

1. Private API keys or service-role keys exposed in frontend or repo
2. Unprotected admin routes (no auth or auth bypassable)
3. Cross-tenant data access (user A can read user B's data)
4. Public paid-API endpoint with no rate limit or auth (billing loop)
5. Unverified payment webhooks (no signature check)
6. PII / secrets written to logs without redaction
7. Unsafe file uploads (no type/size validation, no isolation)
8. Database accessible from frontend with broad permissions (e.g., `anon` can `select *`)

The audit short-circuits to **Do Not Launch** if any hard blocker is detected.

## Tooling

The skill prefers real static-analysis tools when installed and falls back to repo-scoped heuristic scanners. To unlock the full audit, install:

```bash
# Required for most checks
brew install gitleaks osv-scanner semgrep
npm install -g lighthouse pa11y @axe-core/cli

# Optional — DAST against live URL
brew install nuclei
docker pull ghcr.io/zaproxy/zaproxy:stable

# Optional — container/IaC scanning
brew install trivy
```

The `scripts/audit.ts` script auto-detects which tools are present and emits a `tooling.json` with the resolved tool path or `null` if unavailable.

## Triage layer (FP cut)

Heuristic-source findings (the in-process regex scanners) have a meaningful false-positive rate — most commonly when the rule matches its own definition inside the skill's own source, or matches a documentation string. Two-stage triage cuts this.

```bash
# Stage 1: deterministic reproduce-the-finding (no LLM, no cost)
bun scripts/audit.ts --repo . --triage

# Stage 2: + 2-vendor consensus on survivors at severity >= medium
bun scripts/audit.ts --repo . --triage --consensus
#   requires OPENAI_API_KEY + ANTHROPIC_API_KEY in env
```

**Stage 1 (reproduce)** re-reads the file/line of each heuristic finding and drops obvious FPs:
- match inside a comment (skipped for rules that target comments by design)
- match inside a block comment
- match inside a regex literal (the rule matching itself)
- match inside a `description:` / `message:` / `title:` / `remediation:` string property
- match in a markdown documentation file
- match inside a `rule.id` / `check.name` / `finding.title` definition

**Stage 2 (consensus)** routes findings through `synthetic.new` for a 3-vendor quorum vote — default vendors are three non-reasoning instruct models from distinct families (`gpt-oss-120b`, `Llama-3.3-70B-Instruct`, `Qwen3-Coder-480B`). Requires `SYNTHETIC_NEW_API_KEY` in env. Override via `PRODUCTION_READY_VENDORS=model1,model2,model3`.

Decision policy:
- **2+ vote `real`** → keep at original severity
- **2+ vote `fp`** → drop (recorded in `triage-dropped.json`)
- **genuine split** among 2+ responders → downgrade one severity tier, mark `needsHumanReview`
- **fewer than 2 responses** → keep at original severity (consensus inconclusive, no penalty)

Tool-sourced findings (`gitleaks`, `semgrep`, `osv-scanner`, etc.) are never triaged away — those signals are already verified.

Verified self-audit FP cut: 7 high → 0 high; verdict flipped 🟠 Private-Beta-Only → 🟢 Launch-Ready. Verified no regression on a deliberately-vulnerable test app (5 critical + 7 high preserved, hard-blockers intact).

## Godmode

Pass `--godmode` to:

1. Run every check, even ones that need a live URL (will note "URL not provided" rather than skip)
2. Apply experimental AI-code heuristics (slower, higher false-positive rate, catches more)
3. **Auto-enable `--triage`** (reproduce pass) to cut FPs from the broader rule set
4. Generate copy-paste prompts for *every* finding, not just critical/high
5. Open the HTML report in your browser (via `xdg-open` / `open`) when finished
6. Drop a `LAUNCH_CHECKLIST.md` in the audited repo root for stakeholder sign-off

```bash
bun scripts/audit.ts --repo . --url https://staging.foo.app --godmode
```

## CI integration

A GitHub Actions workflow lives at `.github/workflows/audit.yml`. Add it to any repo:

```bash
cp /home/workspace/Skills/production-ready/.github/workflows/audit.yml \
   /path/to/your/repo/.github/workflows/production-ready.yml
```

It runs the audit on every PR, comments findings inline, and fails the build on **Do Not Launch**.

## References

- `references/owasp-top-10.md` — OWASP 2021 + API Security 2023 + LLM Top 10
- `references/tool-reference.md` — Every CLI tool used, with install + invocation
- `references/ai-failure-modes.md` — Cataloged AI-generated-code antipatterns
- `references/production-checklist.md` — Google SRE + AWS WAF + GitLab merged
- `references/compliance.md` — SOC 2 / GDPR / CCPA / PCI-DSS starter requirements
- `references/audit-config-schema.md` — Full `audit.config.json` schema

## Exit codes

- `0` — Launch-Ready
- `1` — Launch with Monitoring
- `2` — Private Beta Only
- `3` — Do Not Launch
- `10` — Audit error (script crashed, tool failed, missing inputs)

CI pipelines should fail on `>= 2`. Internal teams may choose to fail on `>= 1`.
