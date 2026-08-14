/**
 * Domain 3: Authentication & Authorization
 *
 *  - Server-side auth enforcement
 *  - Ownership checks (BOLA / IDOR)
 *  - Admin route protection
 *  - Session safety
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { runCommand, walkRepo, grepFiles, whichTool, isSource } from "../lib/runners.ts";
import { join } from "node:path";

export const authenticationCheck: CheckModule = {
  domain: "authentication",
  description: "Audit authentication enforcement, ownership checks, and admin route protection.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];
    const toolsUsed: string[] = [];
    const toolsMissing: string[] = [];

    if (!config.repoPath) {
      return {
        domain: "authentication",
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        toolsUsed: [],
        toolsMissing: [],
        findings: [],
        manualChecklist: [{ item: "Provide --repo to audit authentication code paths.", rationale: "Auth check requires source access." }],
      };
    }
    const repo = config.repoPath;

    // ── semgrep auth rules ──────────────────────────────────────
    const semgrep = whichTool("semgrep");
    if (semgrep.available) {
      toolsUsed.push("semgrep");
      const res = runCommand(
        "semgrep",
        ["--config", "p/jwt", "--config", "p/owasp-top-ten", "--severity", "ERROR", "--severity", "WARNING", "--json", "--quiet", repo],
        { timeoutMs: 240_000 },
      );
      if (res.stdout) {
        try {
          const j = JSON.parse(res.stdout);
          for (const r of (j.results ?? []).slice(0, 30)) {
            const rid = r.check_id ?? "";
            if (!/auth|jwt|session|cookie|csrf|access/i.test(rid)) continue;
            const sev = r.extra?.severity === "ERROR" ? "high" : "medium";
            findings.push({
              id: `auth.semgrep.${rid}.${(r.path ?? "x").replace(/\//g, "_")}.${r.start?.line ?? 0}`,
              domain: "authentication",
              severity: sev,
              title: `Semgrep: ${rid}`,
              description: r.extra?.message ?? "Semgrep flagged a possible authentication issue.",
              evidence: [{ file: rel(r.path, repo), line: r.start?.line, snippet: (r.extra?.lines ?? "").trim().slice(0, 200) }],
              remediation: r.extra?.fix ?? "Review the flagged location and ensure auth is enforced server-side.",
              source: `semgrep:${rid}`,
              references: r.extra?.metadata?.references ?? [],
            });
          }
        } catch {}
      }
    } else {
      toolsMissing.push("semgrep");
    }

    // ── heuristic: admin routes without auth middleware ───────────
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });
    const adminPatterns = [
      /['"`]\/admin/,
      /\/api\/admin/i,
      /role.{0,10}===?\s*['"`]admin/i,
      /isAdmin|is_admin/,
    ];
    for (const p of adminPatterns) {
      const hits = grepFiles(sourceFiles, p, { maxMatches: 10 });
      for (const hit of hits) {
        // Look at the surrounding lines (cheap heuristic) — is there any auth call near?
        // We can't read context here perfectly, so we just surface the location as a manual review item.
        if (findings.some((f) => f.evidence?.some((e) => e.file === rel(hit.file, repo) && e.line === hit.line))) continue;
        findings.push({
          id: `auth.admin-route-review.${rel(hit.file, repo)}.${hit.line}`,
          domain: "authentication",
          severity: "medium",
          title: "Admin reference — verify auth gate",
          description: "Found an `admin` reference in source. Confirm the surrounding handler enforces server-side authentication AND a role check before allowing access.",
          evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
          remediation: "Wrap the route in an `assertAdmin(req)` (or framework equivalent) at the *server* layer. Never gate admin UI client-side only.",
          source: "production-ready:admin-grep",
          references: ["https://owasp.org/Top10/A01_2021-Broken_Access_Control/"],
        });
      }
    }

    // ── disabled CSRF / cookie security ──────────────────────────
    const csrfDisabled = grepFiles(sourceFiles, /\b(csrf|sameSite|secure)\s*[:=]\s*(false|None|"none")/i, { maxMatches: 10 });
    for (const hit of csrfDisabled) {
      findings.push({
        id: `auth.csrf-or-cookie-disabled.${rel(hit.file, repo)}.${hit.line}`,
        domain: "authentication",
        severity: "high",
        title: "CSRF or cookie security disabled",
        description: "A config explicitly disables CSRF protection or weakens cookie security. Verify this is not happening in production.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
        remediation: "Use `sameSite: 'lax'` (or `'strict'` for sensitive cookies), `secure: true`, `httpOnly: true`. Keep CSRF enabled on cookie-auth APIs.",
        source: "production-ready:cookie-grep",
        references: ["https://owasp.org/www-community/attacks/csrf"],
      });
    }

    // ── insecure JWT patterns ────────────────────────────────────
    const jwtNone = grepFiles(sourceFiles, /algorithm.{0,5}(none|None|HS256.{0,40}none)/i, { maxMatches: 5 });
    for (const hit of jwtNone) {
      findings.push({
        id: `auth.jwt-alg-none.${rel(hit.file, repo)}.${hit.line}`,
        domain: "authentication",
        severity: "critical",
        hardBlocker: true,
        title: "JWT alg='none' allowed",
        description: "Accepting `alg: none` lets anyone forge a valid token by signing nothing.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
        remediation: "Explicitly allowlist algorithms (e.g., `algorithms: ['RS256']`) in JWT verify calls. Never accept `none`.",
        source: "production-ready:jwt-grep",
        references: ["https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/06-Session_Management_Testing/10-Testing_JSON_Web_Tokens"],
      });
    }

    return {
      domain: "authentication",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed,
      toolsMissing,
      findings,
      manualChecklist: [
        { item: "Test ownership boundaries — sign in as user A, try to access user B's resources via direct URL", rationale: "BOLA / IDOR is the #1 API vuln per OWASP API Top 10 2023." },
        { item: "Verify MFA is available (and required for admin)", rationale: "Compromised passwords are the most common breach vector." },
        { item: "Confirm session timeout + inactivity logout exists", rationale: "Long-lived sessions on shared/public devices are a leak path." },
        { item: "Check rate limit on login + password reset endpoints", rationale: "Credential stuffing & enumeration require throttling." },
      ],
    };
  },
};

function rel(full: string | undefined, root: string): string {
  if (!full) return "";
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}
