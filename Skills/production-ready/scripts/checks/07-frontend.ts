/**
 * Domain 7: Frontend Exposure
 *
 *  - Source maps shipped to production
 *  - Secrets / sensitive endpoints inlined into bundles
 *  - localStorage / sessionStorage abuse (tokens stored there)
 *  - Hard-coded internal URLs / IPs
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource } from "../lib/runners.ts";

export const frontendCheck: CheckModule = {
  domain: "frontend",
  description: "Audit frontend bundles for leaks: sourcemaps, tokens in localStorage, internal URLs.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("frontend", startedAt);
    const repo = config.repoPath;

    // Inspect build output if present
    const buildDirs = ["dist", "build", ".next/static", "out", ".output/public", ".vercel/output/static"]
      .map((d) => join(repo, d))
      .filter((d) => existsSync(d));

    let mapCount = 0;
    for (const bd of buildDirs) {
      const maps = walkRepo(bd, (rel) => rel.endsWith(".js.map") || rel.endsWith(".mjs.map") || rel.endsWith(".css.map"), { maxFiles: 200 });
      mapCount += maps.length;
    }
    if (mapCount > 0) {
      findings.push({
        id: "frontend.sourcemaps-in-build",
        domain: "frontend",
        severity: "medium",
        title: `${mapCount} sourcemap file(s) found in build output`,
        description: "Production sourcemaps reveal your full source tree — helpful for debugging but unnecessary for end users and useful to attackers. If you keep them, gate them behind auth or upload them only to your error tracker.",
        remediation: "Set `productionBrowserSourceMaps: false` (Next.js) / `build.sourcemap: false` (Vite) for public deploys. Upload sourcemaps to Sentry/Datadog separately with a delete-on-upload step.",
        source: "production-ready:bundle-scan",
        references: ["https://nextjs.org/docs/pages/api-reference/next-config-js/productionBrowserSourceMaps"],
      });
    }

    // localStorage token storage (a fragile but commonly-AI-generated pattern)
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });
    const tokenInStorage = grepFiles(sourceFiles, /(localStorage|sessionStorage)\.setItem\(\s*['"`](token|access[_-]?token|jwt|auth|session|api[_-]?key)/i, { maxMatches: 15 });
    for (const hit of tokenInStorage) {
      findings.push({
        id: `frontend.token-in-storage.${rel(hit.file, repo)}.${hit.line}`,
        domain: "frontend",
        severity: "medium",
        title: "Auth token stored in localStorage/sessionStorage",
        description: "Tokens in browser storage are readable by any JS that runs on the page, including a successful XSS. The accepted pattern is httpOnly+Secure+SameSite cookies for session, set server-side.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
        remediation: "Move the session to an httpOnly cookie set by the server. If you must use bearer tokens, accept that an XSS compromises the session and harden everything else accordingly.",
        source: "production-ready:storage-grep",
        references: ["https://owasp.org/www-community/HttpOnly"],
      });
    }

    // Hard-coded internal URLs / IPs
    const internalUrls = grepFiles(sourceFiles, /(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|internal\.\w+\.|staging\.\w+\.)/i, { maxMatches: 10 });
    for (const hit of internalUrls.slice(0, 5)) {
      findings.push({
        id: `frontend.internal-url.${rel(hit.file, repo)}.${hit.line}`,
        domain: "frontend",
        severity: "low",
        title: "Internal URL / IP hardcoded in source",
        description: "Hard-coded internal hostnames or IPs end up in the production bundle and may reveal architecture details to attackers.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
        remediation: "Move URLs to environment-driven config. Verify the build pipeline strips dev-only paths.",
        source: "production-ready:internal-url-grep",
      });
    }

    return {
      domain: "frontend",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:bundle-scan"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Open DevTools → Network tab on the production app — is any request going to a dev/staging URL?", rationale: "AI-generated code commonly leaves mixed-environment URLs after a copy-paste." },
        { item: "Check the bundle for comments / console.log statements", rationale: "Debug output may leak request/response shapes and PII." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
