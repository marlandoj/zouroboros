/**
 * Domain 8: Logging & Monitoring
 *
 *  - Detect logging of sensitive fields (Authorization, password, token, body)
 *  - Console.log left in production
 *  - Lack of structured logger
 *  - Lack of error tracker integration
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

export const loggingCheck: CheckModule = {
  domain: "logging",
  description: "Audit logging hygiene and observability presence.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("logging", startedAt);
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });

    // PII in logs
    const piiLogPatterns = [
      /log.{0,20}(authorization|api[_-]?key|password|token|secret|cookie|session)/i,
      /console\.(log|info|warn|error)\(.{0,30}(password|token|api[_-]?key|authorization)/i,
      /print\(.{0,30}(password|token|api[_-]?key|authorization)/i,
    ];
    for (const p of piiLogPatterns) {
      const hits = grepFiles(sourceFiles, p, { maxMatches: 10 });
      for (const hit of hits) {
        findings.push({
          id: `logging.pii-leak.${rel(hit.file, repo)}.${hit.line}`,
          domain: "logging",
          severity: "high",
          hardBlocker: false,
          title: "Sensitive field referenced in a log/print call",
          description: "A log statement appears to include an authorization header, token, password, or API key. Secrets in logs end up in centralized log stores, support tools, and accidentally in screenshots.",
          evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet.slice(0, 200) }],
          remediation: "Use a redaction layer (e.g., pino redact, structlog processors). Log only field names + a hash if you need to correlate. Treat `Authorization`, `Cookie`, `password`, `token`, `secret`, `api_key` as never-loggable.",
          source: "production-ready:pii-log-grep",
          references: ["https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/"],
        });
      }
    }

    // Excessive console.log in source (not just dev)
    let consoleCount = 0;
    let printPyCount = 0;
    for (const file of sourceFiles) {
      const content = safeRead(file);
      if (!content) continue;
      consoleCount += (content.match(/console\.log\(/g) ?? []).length;
      printPyCount += (content.match(/^\s*print\(/gm) ?? []).length;
    }
    if (consoleCount > 30 || printPyCount > 30) {
      findings.push({
        id: "logging.console-noise",
        domain: "logging",
        severity: "low",
        title: `High volume of ad-hoc log statements (console.log: ${consoleCount}, print: ${printPyCount})`,
        description: "AI-generated code routinely leaves debug `console.log` / `print` calls in place. They produce log noise, may leak data, and cost CPU on hot paths.",
        remediation: "Adopt a structured logger (pino, winston, structlog, loguru). Strip / lint console.log in production builds (`no-console` ESLint rule).",
        source: "production-ready:log-volume",
      });
    }

    // No structured logger or error tracker
    const hasStructuredLogger = grepFiles(sourceFiles, /(pino|winston|bunyan|structlog|loguru|zerolog|logrus|slog)/i, { maxMatches: 1 });
    const hasErrorTracker = grepFiles(sourceFiles, /(Sentry|@sentry\/|datadog-lambda|honeycombio|@honeycombio|new\s+Bugsnag|posthog\.init)/i, { maxMatches: 1 });
    if (hasStructuredLogger.length === 0) {
      findings.push({
        id: "logging.no-structured-logger",
        domain: "logging",
        severity: "medium",
        title: "No structured logger detected",
        description: "Unstructured logs are harder to search, redact, and rate-limit. They cost more in centralized log stores.",
        remediation: "Adopt pino (Node), structlog (Python), zap/slog (Go). Configure built-in PII redaction. Tag every log with request_id, user_id (hashed), tenant_id.",
        source: "production-ready:logger-grep",
      });
    }
    if (hasErrorTracker.length === 0) {
      findings.push({
        id: "logging.no-error-tracker",
        domain: "logging",
        severity: "medium",
        title: "No error tracker integration detected",
        description: "Unobserved errors are unfixed errors. Without Sentry/Bugsnag/Datadog, you find out about prod issues from angry users.",
        remediation: "Wire Sentry (or equivalent) on both client and server. Set release/environment tags. Configure source-map upload.",
        source: "production-ready:tracker-grep",
        references: ["https://docs.sentry.io/"],
      });
    }

    return {
      domain: "logging",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:logger-grep"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Verify centralized logs are searchable for at least 7 days", rationale: "Incidents are often noticed after they end; you need retention to retro." },
        { item: "Confirm uptime monitor with on-call paging (StatusCake / BetterStack / Pingdom)", rationale: "External probe catches what your internal metrics can't." },
        { item: "Per-tenant audit trail for: auth events, permission changes, admin actions, data exports", rationale: "Required for SOC 2 + GDPR + breach forensics." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
