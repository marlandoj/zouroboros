/**
 * Domain 6: Abuse, Cost & Rate Limits
 *
 *  - LLM/AI calls without rate guards
 *  - Image/email/SMS APIs without throttling
 *  - Body size limits
 *  - Webhook idempotency keys
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

export const abuseRateCheck: CheckModule = {
  domain: "abuse-rate",
  description: "Audit guardrails on costly / abuse-prone endpoints (LLM, email, SMS, uploads).",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("abuse-rate", startedAt);
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });

    // ── LLM / paid-API calls in handlers ────────────────────────
    const costlySDKPatterns = [
      { name: "OpenAI", pattern: /openai\.(chat|completions|embeddings|images|audio)/i },
      { name: "Anthropic", pattern: /anthropic\.messages|client\.messages\.create/i },
      { name: "Stability/Replicate", pattern: /replicate\.run|stability\.generate/i },
      { name: "Resend/SendGrid/Mailgun", pattern: /(resend|sendgrid|mailgun)\.(emails?|messages?)\./i },
      { name: "Twilio", pattern: /twilio.{0,30}(messages|create)/i },
    ];
    const hasRateLimitImport = sourceFiles.some((f) => {
      const c = safeRead(f);
      return c ? /(express-rate-limit|@upstash\/ratelimit|rate-limiter-flexible|slowapi|django-ratelimit|hono-rate-limiter)/i.test(c) : false;
    });

    for (const { name, pattern } of costlySDKPatterns) {
      const hits = grepFiles(sourceFiles, pattern, { maxMatches: 5 });
      if (hits.length === 0) continue;
      if (!hasRateLimitImport && config.surfaces?.ai !== false) {
        findings.push({
          id: `abuse.unbounded-${name.toLowerCase()}.call`,
          domain: "abuse-rate",
          severity: "high",
          hardBlocker: !!config.surfaces?.payments,
          title: `${name} API calls detected with no rate-limit middleware`,
          description: `Found ${hits.length} call site(s) to the ${name} API but no rate-limiting library is imported anywhere in the repo. An unauthenticated or weakly-throttled endpoint that wraps a paid API is a billing-DoS risk.`,
          evidence: hits.slice(0, 3).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
          remediation: [
            "1. Wrap every public route that triggers a paid API with a per-IP AND per-user rate limit.",
            "2. Add a per-tenant hard daily budget cap (LLM tokens, emails sent, images generated).",
            "3. Alert when daily spend exceeds 1.5× rolling average.",
            "4. Require authentication before the paid call — anonymous access multiplies risk.",
          ].join("\n"),
          source: "production-ready:abuse-grep",
          references: ["https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/", "https://genai.owasp.org/llmrisk/llm10-unbounded-consumption/"],
        });
      }
    }

    // ── Body size limits ────────────────────────────────────────
    const bodyLimitPatterns = [
      /express\.json\(\s*\{[^}]*limit/,
      /express\.json\(\)/,
      /bodyParser\.json\(\s*\{[^}]*limit/,
      /app\.use\(\s*express\.json\(\)\)/,
    ];
    const hasExpressJsonWithoutLimit = grepFiles(sourceFiles, /express\.json\(\s*\)|bodyParser\.json\(\s*\)/, { maxMatches: 5 });
    if (hasExpressJsonWithoutLimit.length > 0) {
      findings.push({
        id: "abuse.no-body-size-limit",
        domain: "abuse-rate",
        severity: "medium",
        title: "Express body parser without explicit size limit",
        description: "`express.json()` defaults to 100kb but custom parsers may have no limit. Unbounded request bodies enable memory-exhaustion DoS.",
        evidence: hasExpressJsonWithoutLimit.slice(0, 3).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        remediation: "Set an explicit limit: `app.use(express.json({ limit: '100kb' }))`. Increase only for routes that genuinely need it.",
        source: "production-ready:body-limit-grep",
      });
    }

    return {
      domain: "abuse-rate",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:abuse-grep"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Confirm a per-tenant daily/monthly cost cap is enforced at the application layer", rationale: "Rate limits alone don't prevent a single bad actor from draining a budget within their quota." },
        { item: "Bot/CAPTCHA on signup + login + 'forgot password'", rationale: "Most abuse arrives via cheap-account creation." },
        { item: "Billing-anomaly alert wired to ops channel", rationale: "Catch runaway costs in minutes not days." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
