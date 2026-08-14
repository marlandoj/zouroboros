/**
 * Domain 11: Payments & Webhooks
 *
 *  - Stripe webhook signature verification
 *  - Idempotency keys / unique constraints
 *  - Secret key handling (server-only)
 *  - Raw body capture before json middleware
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

export const paymentsCheck: CheckModule = {
  domain: "payments",
  description: "Audit payment + webhook handling (Stripe-aware).",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("payments", startedAt);
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });

    // Detect Stripe usage
    const stripeImport = grepFiles(sourceFiles, /require\(['"]stripe['"]\)|from\s+['"]stripe['"]|import\s+Stripe/i, { maxMatches: 5 });
    const usesStripe = stripeImport.length > 0;

    if (!usesStripe && !config.surfaces?.payments) {
      // No payments — skip
      return {
        domain: "payments",
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        toolsUsed: [],
        toolsMissing: [],
        findings: [],
        manualChecklist: [{ item: "Confirm app has no money-handling surface", rationale: "If payments appear later, re-run this check." }],
      };
    }

    // Webhook signature verification
    const webhookFiles = sourceFiles.filter((f) => /webhook/i.test(f));
    let foundSignatureCheck = false;
    for (const f of webhookFiles) {
      const c = safeRead(f);
      if (!c) continue;
      if (/constructEvent|verify_header|webhook\.verify|webhooks\.constructEvent/i.test(c)) {
        foundSignatureCheck = true;
        break;
      }
    }
    if (webhookFiles.length > 0 && !foundSignatureCheck) {
      findings.push({
        id: "payments.unverified-webhook",
        domain: "payments",
        severity: "critical",
        hardBlocker: true,
        title: "Webhook handler without signature verification",
        description: "Found webhook handler file(s) but no call to `stripe.webhooks.constructEvent` (or equivalent). Unverified webhooks let anyone POST forged events and trigger your billing / fulfillment logic.",
        evidence: webhookFiles.slice(0, 3).map((f) => ({ file: rel(f, repo) })),
        remediation: [
          "1. Capture raw body BEFORE any JSON middleware (`express.raw({ type: 'application/json' })`).",
          "2. Call `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)` and let it throw on bad signatures.",
          "3. Store the endpoint secret in env (different per env: dev / staging / prod).",
          "4. Idempotency: persist `event.id` with a UNIQUE constraint; return 200 on duplicate.",
          "5. Enqueue async work; return 2xx fast.",
        ].join("\n"),
        source: "production-ready:webhook-grep",
        references: ["https://stripe.com/docs/webhooks/signatures"],
      });
    }

    // Stripe secret key on the client side
    const stripeFrontendLeak = grepFiles(sourceFiles, /sk_(live|test)_[A-Za-z0-9]{20,}/, { maxMatches: 5 });
    for (const hit of stripeFrontendLeak) {
      // If the file looks frontend (jsx/tsx, vue, svelte), flag critically
      const isFrontend = /\.(jsx|tsx|vue|svelte|astro|html)$/i.test(hit.file);
      findings.push({
        id: `payments.stripe-secret-${isFrontend ? "frontend" : "code"}.${rel(hit.file, repo)}.${hit.line}`,
        domain: "payments",
        severity: isFrontend || hit.match.startsWith("sk_live_") ? "critical" : "high",
        hardBlocker: isFrontend || hit.match.startsWith("sk_live_"),
        title: `Stripe secret key in ${isFrontend ? "frontend" : "source"}`,
        description: "Stripe secret keys must never appear in frontend code. They must only live in server-side env vars and never be hard-coded.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet.replace(/sk_(live|test)_[A-Za-z0-9]+/, "sk_$1_REDACTED") }],
        remediation: "Rotate the key immediately at https://dashboard.stripe.com/apikeys. Move to a server-only env var. Use Stripe Elements / Checkout (publishable key only) on the client.",
        source: "production-ready:stripe-key-grep",
        references: ["https://stripe.com/docs/keys"],
      });
    }

    // Idempotency tracking present?
    const idempotencyMentions = grepFiles(sourceFiles, /(event\.id|idempotency[_-]?key|Idempotency-Key)/i, { maxMatches: 5 });
    if (usesStripe && webhookFiles.length > 0 && idempotencyMentions.length === 0) {
      findings.push({
        id: "payments.no-idempotency",
        domain: "payments",
        severity: "high",
        title: "No idempotency tracking detected in webhook handler",
        description: "Stripe retries failed webhooks for 3 days. Without idempotency, you may double-charge, double-fulfill, or double-email.",
        remediation: "Persist `event.id` with a UNIQUE database constraint; check-then-process inside a transaction; return 200 on duplicate without re-processing.",
        source: "production-ready:idempotency-grep",
        references: ["https://stripe.com/docs/idempotency"],
      });
    }

    return {
      domain: "payments",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:payments-grep"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Confirm SAQ A compliance is met (Stripe Elements / Checkout iframe, no card data touches your server)", rationale: "PCI-DSS 4.0 enforced since 2025-04-01 — 6.4.3 and 11.6.1 are mandatory for SAQ A merchants." },
        { item: "Different `whsec_*` per environment, stored in a secret manager", rationale: "Leaked staging webhook secret = forge production webhooks." },
        { item: "Test the failure path: what if Stripe returns 5xx? what if your DB is down mid-webhook?", rationale: "Failure handling is where double-charges originate." },
        { item: "Fraud / risk rules configured in Stripe dashboard (Radar)", rationale: "Defaults are minimal — high-risk verticals need tuning." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
