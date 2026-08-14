/**
 * Domain 4: API Route Safety
 *
 *  - Input validation on handlers
 *  - HTTP method enforcement
 *  - CORS configuration
 *  - Rate limiting middleware
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

const REQUEST_INPUT = /req\.(?:body|query|params)\b|request\.(?:json|form)\s*\(|c\.req\.(?:json|query|param)\s*\(/;
const HANDLER_START = /(?:\b[A-Za-z_$][\w$]*\.(?:get|post|put|patch|delete|all)\s*\(|\bexport\s+(?:default\s+)?async\s+function\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s*=)/;
const SCHEMA_VALIDATION = /\b(?:safeParse|parseAsync|validateSync|validateOrReject)\s*\(|\.(?:safeParse|parse|validate)\s*\(|\bzValidator\s*\(/;
const MANUAL_VALIDATION = /(?:\btypeof\s+[^\n;]+\s*(?:===|!==)\s*["'](?:string|number|boolean|object)["']|\bArray\.isArray\s*\(|\bNumber\.is(?:Finite|Integer|NaN)\s*\(|(?<![\w.])isNaN\s*\(|\binstanceof\s+Date\b|\.getTime\s*\(\)|\bObject\.values\s*\([^)]*\)\.includes\s*\(|\b(?:allowed|valid|supported|statuses|types|kinds|roles)\w*\.(?:includes|has)\s*\(|\b(?:enum|date|uuid|email|url)\w*\.(?:test|match)\s*\(|\bif\s*\([^\n)]*(?:!\s*[A-Za-z_$][\w$]*(?:\?\.[\w$]+)?|(?:===|!==)\s*(?:null|undefined)|(?:===|!==)\s*["'][^"']+["']))/i;

export interface ValidationCoverage {
  total: number;
  validated: number;
  unvalidated: Array<{ file: string; line: number; snippet: string }>;
}

/** Score each request-input boundary independently so one schema import cannot
 * make unrelated handlers in the same file appear validated. */
export function measureValidationCoverage(sourceFiles: string[]): ValidationCoverage {
  const coverage: ValidationCoverage = { total: 0, validated: 0, unvalidated: [] };

  for (const file of sourceFiles) {
    const content = safeRead(file);
    if (!content) continue;
    const lines = content.split("\n");
    const handlerStarts = lines.flatMap((line, index) => HANDLER_START.test(line) ? [index] : []);
    const covered = new Set<number>();

    for (let handler = 0; handler < handlerStarts.length; handler++) {
      const start = handlerStarts[handler];
      const end = handlerStarts[handler + 1] ?? lines.length;
      const inputLine = lines.findIndex((line, index) => index >= start && index < end && REQUEST_INPUT.test(line));
      if (inputLine < 0) continue;
      for (let i = start; i < end; i++) covered.add(i);
      coverage.total++;
      const boundary = lines.slice(start, end).join("\n");
      if (SCHEMA_VALIDATION.test(boundary) || MANUAL_VALIDATION.test(boundary)) {
        coverage.validated++;
      } else {
        coverage.unvalidated.push({ file, line: inputLine + 1, snippet: lines[inputLine].trim().slice(0, 240) });
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (covered.has(i) || !REQUEST_INPUT.test(lines[i])) continue;
      coverage.total++;
      const end = Math.min(lines.length, i + 31);
      const boundary = lines.slice(i, end).join("\n");
      if (SCHEMA_VALIDATION.test(boundary) || MANUAL_VALIDATION.test(boundary)) {
        coverage.validated++;
      } else {
        coverage.unvalidated.push({ file, line: i + 1, snippet: lines[i].trim().slice(0, 240) });
      }
    }
  }

  return coverage;
}

export function hasProjectRateLimit(sourceFiles: string[]): boolean {
  const contents = sourceFiles.map((file) => ({ file, content: safeRead(file) ?? "" }));
  const operationalSignal = /\b429\b|Retry-After|Too Many Requests|windowMs|maxRequests|requestsPer|token.?bucket/i;
  const declaration = /\b(?:function|class|const|let)\s+([A-Za-z_$][\w$]*(?:rate.?limit|throttl)[\w$]*)/gi;
  const inboundRequestSignal = /\bc\.req\b|\breq\.(?:ip|headers|socket|user)\b|x-forwarded-for|app\.use\s*\(|router\.use\s*\(|\bmiddleware\b/i;

  for (const { content } of contents) {
    if (!operationalSignal.test(content)) continue;
    declaration.lastIndex = 0;
    for (let match = declaration.exec(content); match; match = declaration.exec(content)) {
      const name = match[1];
      if (/Error$/i.test(name)) continue;
      const usage = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
      const occurrences = contents.reduce((count, item) => count + (item.content.match(usage)?.length ?? 0), 0);
      const inboundUse = contents.some((item) => item.content.includes(name) && inboundRequestSignal.test(item.content));
      if (occurrences >= 2 && inboundUse) return true;
    }
  }

  return contents.some(({ file, content }) =>
    /(?:^|[\\/])(?:rate[-_.]?limit|throttl)[^\\/]*middleware[^\\/]*\.[^.]+$/i.test(file)
    && operationalSignal.test(content)
    && inboundRequestSignal.test(content),
  );
}

export const apiSafetyCheck: CheckModule = {
  domain: "api-safety",
  description: "Audit API route safety: validation, method gating, CORS, rate limits.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) {
      return empty("api-safety", startedAt);
    }
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });

    // ── Permissive CORS ─────────────────────────────────────────
    const cors = grepFiles(
      sourceFiles,
      /Access-Control-Allow-Origin.{0,5}\*|origin:\s*['"`]\*['"`]|cors\(\s*\{\s*origin:\s*true\s*\}\s*\)|allow_origins\s*=\s*\[?["']\*/i,
      { maxMatches: 20 },
    );
    for (const hit of cors) {
      findings.push({
        id: `api.cors-wildcard.${rel(hit.file, repo)}.${hit.line}`,
        domain: "api-safety",
        severity: "high",
        title: "Wildcard CORS allows any origin",
        description: "`Access-Control-Allow-Origin: *` (combined with credentials) is a known auth bypass. Even without credentials, it enables cross-origin abuse.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
        remediation: "Allowlist specific origins. Reject unexpected `Origin` headers. Never combine `Access-Control-Allow-Origin: *` with `Allow-Credentials: true`.",
        source: "production-ready:cors-grep",
        references: ["https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS"],
      });
    }

    // ── Missing input validation on handlers ────────────────────
    const validation = measureValidationCoverage(sourceFiles);
    const hitTotal = validation.total;
    const hitWithValidationLibs = validation.validated;
    if (hitTotal > 0 && hitWithValidationLibs / hitTotal < 0.3) {
      findings.push({
        id: "api.low-validation-coverage",
        domain: "api-safety",
        severity: hitTotal > 30 ? "high" : "medium",
        title: `Low validation coverage on API handlers (${hitWithValidationLibs}/${hitTotal})`,
        description: `Only ${hitWithValidationLibs} of ${hitTotal} request-input boundaries apply a nearby schema validator or explicit runtime type/date/enum guard. Unvalidated input is the root of injection, IDOR, and DoS bugs.`,
        evidence: validation.unvalidated.slice(0, 5).map((hit) => ({ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet })),
        remediation: "Validate every handler input at the boundary. Reject early on invalid input with a schema validator or explicit runtime guards.",
        source: "production-ready:validation-coverage",
        references: ["https://owasp.org/Top10/A03_2021-Injection/"],
      });
    }

    // ── No rate limit middleware ────────────────────────────────
    const rateLimitHits = grepFiles(
      sourceFiles,
      /(express-rate-limit|fastify-rate-limit|rate-limiter-flexible|@upstash\/ratelimit|slowapi|django-ratelimit|hono-rate-limiter|next-rate-limit)/i,
      { maxMatches: 5 },
    );
    if (rateLimitHits.length === 0 && !hasProjectRateLimit(sourceFiles) && hitTotal > 0) {
      findings.push({
        id: "api.no-rate-limit",
        domain: "api-safety",
        severity: "high",
        title: "No rate-limiting middleware detected",
        description: `Detected ${hitTotal} API handlers but no rate-limiting library is imported anywhere. Public APIs without rate limits invite credential stuffing, scraping, and billing abuse.`,
        remediation: "Add a rate limiter at the edge or middleware layer (express-rate-limit, @upstash/ratelimit, or your platform's WAF). Limit per IP AND per user. Apply stricter limits to auth/password-reset routes.",
        source: "production-ready:rate-limit-grep",
        references: ["https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/"],
      });
    }

    // ── Generic HTTP catch-all (no method check) ────────────────
    // (Express) router.use without method binding indicates blanket handler — usually fine but worth flagging if it touches user data
    // Skip for now (too noisy in heuristic mode)

    return {
      domain: "api-safety",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:repo-grep"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Verify every state-changing endpoint requires POST/PUT/PATCH/DELETE (not GET)", rationale: "GET requests are logged in browser history, referrer headers, and CDN logs." },
        { item: "Confirm OpenAPI/Swagger spec exists and matches implementation", rationale: "Drift between docs and code hides shadow endpoints." },
        { item: "Test rate limits return 429 with a Retry-After header", rationale: "Some implementations silently drop; clients need feedback." },
      ],
    };
  },
};

function rel(full: string | undefined, root: string): string {
  if (!full) return "";
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}

function empty(domain: any, startedAt: number): CheckResult {
  return {
    domain,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    toolsUsed: [],
    toolsMissing: [],
    findings: [],
    manualChecklist: [{ item: "Provide --repo to run this check.", rationale: "Source access required." }],
  };
}
