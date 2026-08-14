# Production-Readiness Checklist

Merged intersection of Google SRE, AWS Well-Architected, GitLab Production Readiness Review, and Datadog's launch checklist. These items are not automated — they're for the human review pass.

## SLOs & error budgets

- [ ] SLIs defined for each top-N user journey (availability, latency p50/p95/p99, error rate)
- [ ] SLOs published with explicit window (e.g., "99.9% over rolling 28 days")
- [ ] Error budget burn-rate alerts (1h, 6h, 24h windows)
- [ ] Budget exhaustion playbook (freeze feature work, rollback recent release)

## Observability

- [ ] Structured logs with trace_id / request_id propagation
- [ ] Dashboards exist for each critical path
- [ ] Per-route latency histograms
- [ ] Per-tenant cost / usage visibility
- [ ] Alerts route to on-call (PagerDuty / Opsgenie / equivalent)
- [ ] On-call rotation defined, primary + secondary, paged within last 30 days as a drill

## Health checks

- [ ] Liveness endpoint (does the process exist?)
- [ ] Readiness endpoint (can it serve traffic?)
- [ ] Graceful shutdown on SIGTERM (drain in-flight, close DB pools, then exit)
- [ ] Startup health gates dependencies (DB reachable, secrets loaded)

## Runbooks

- [ ] One runbook per critical alert (cause, blast radius, mitigation, rollback)
- [ ] Postmortem template ready
- [ ] Communication playbook for customer-impacting incidents (status page, email)

## Capacity & resilience

- [ ] Load test at ≥ 2× projected peak completed in staging
- [ ] Autoscaling tested by triggering a synthetic load spike
- [ ] Circuit breakers / bulkheads on each external dependency
- [ ] Timeouts on every network call (DB, cache, HTTP) — never default infinity
- [ ] Retries with exponential backoff + jitter; idempotency guarantees verified
- [ ] Connection pools sized; pool exhaustion alerts wired

## Dependencies

- [ ] Each upstream dependency documented: SLA, failure mode, fallback
- [ ] Failover tested for each (or accept the downtime and document the RTO)
- [ ] DPA signed with each vendor processing personal data

## Rollback & deploy

- [ ] Rollback procedure tested in staging within last 30 days
- [ ] Deploys are canary or blue/green; can shift traffic in < 5 minutes
- [ ] Feature flags wrap every new code path that could surprise
- [ ] Database migrations are forward-compatible (don't break old code paths during rollout)

## Backups

- [ ] Backups run automatically and tested for restorability in last 90 days
- [ ] RPO + RTO documented
- [ ] Restore drill performed end-to-end (not just "the file is there")
- [ ] Cross-region copy of last 7 days of backups

## Secrets & identity

- [ ] All secrets in a vault (1Password Secrets Automation / AWS Secrets Manager / Doppler / Infisical / etc.)
- [ ] No secrets in env-var files or git
- [ ] Rotation cadence defined per credential class
- [ ] Break-glass procedure (how to recover if the vault is compromised)
- [ ] MFA enforced on every admin account
- [ ] Least-privilege IAM, quarterly access review

## Security

- [ ] Threat model exists for the service and its boundaries
- [ ] DAST scan run against the deployed env at least once before launch
- [ ] Penetration test or external audit if SOC 2 / regulated industry
- [ ] Bug bounty / responsible disclosure email documented
- [ ] WAF rules tuned (or accept noise / FPs from a default deny ruleset)

## Cost guardrails

- [ ] Cloud account budget alerts (50%, 80%, 100%)
- [ ] Per-tenant cost attribution at the application layer
- [ ] LLM token budget caps per-user + per-day
- [ ] Anomaly alerts (today's spend > 1.5× rolling 7d average)

## Data lifecycle

- [ ] Retention policy per data type
- [ ] Deletion verified to actually remove from primary + backups + analytics warehouse + LLM training caches
- [ ] Export path (right-to-portability)
- [ ] Data classification reviewed (PII / PHI / payment / public)

## Incident response

- [ ] Severity matrix (Sev 1 / 2 / 3) with response time commitments
- [ ] Status page wired to monitoring (or manual updates documented)
- [ ] Customer-comms template per severity
- [ ] Post-incident review cadence (within 5 business days)

## Compliance specifics

If your org or industry needs them:

- [ ] SOC 2 Type I — quarterly access review, change-management policy, audit logging
- [ ] GDPR — DPA with sub-processors, breach notification ≤ 72h, lawful basis recorded, DPIA for high-risk processing
- [ ] CCPA / CPRA — privacy notice, right-to-know/delete/correct/opt-out endpoints, Global Privacy Control honored
- [ ] PCI-DSS 4.0 SAQ A (Stripe Elements / Checkout merchants) — scripts inventory + integrity (6.4.3), tamper detection (11.6.1), quarterly ASV scan (11.3.2)
- [ ] HIPAA (if handling PHI) — BAAs signed, audit logs on PHI access, encryption at rest + in transit, access controls
