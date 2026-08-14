/**
 * Domain 2: Secrets & Credential Exposure
 *
 *  - Detect secrets in source / build output / env files
 *  - Detect frontend-leakable patterns: NEXT_PUBLIC_*, VITE_*, REACT_APP_* containing secret-like names
 *  - Detect committed .env files
 *  - Detect hard-coded API keys in client bundles (dist/, build/, .next/static)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { runCommand, whichTool, walkRepo, grepFiles, isConfig, isSource } from "../lib/runners.ts";

const SECRET_NAME_HINTS = [
  "secret", "private_key", "privatekey", "api_key", "apikey", "token",
  "auth", "credential", "password", "pwd", "passwd", "key",
  "service_role", "service-role",
];

// Patterns that are commonly true positives. Conservative to keep noise down.
const HIGH_CONFIDENCE_PATTERNS: Array<{ name: string; pattern: RegExp; severity: "critical" | "high" | "medium"; references?: string[] }> = [
  { name: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/, severity: "critical" },
  { name: "AWS Secret", pattern: /aws(.{0,20})?(secret|access).{0,3}key.{0,3}['"][0-9a-zA-Z/+]{40}['"]/i, severity: "critical" },
  { name: "GitHub PAT", pattern: /\bghp_[A-Za-z0-9]{36}\b/, severity: "critical" },
  { name: "GitHub OAuth", pattern: /\bgho_[A-Za-z0-9]{36}\b/, severity: "critical" },
  { name: "GitHub App Token", pattern: /\b(ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, severity: "critical" },
  { name: "Slack Bot Token", pattern: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}\b/, severity: "critical" },
  { name: "Slack User Token", pattern: /\bxox[apr]-[A-Za-z0-9-]{10,}\b/, severity: "critical" },
  { name: "Stripe Live Secret Key", pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/, severity: "critical" },
  { name: "Stripe Restricted Live Key", pattern: /\brk_live_[A-Za-z0-9]{20,}\b/, severity: "critical" },
  { name: "Stripe Test Secret Key", pattern: /\bsk_test_[A-Za-z0-9]{20,}\b/, severity: "high" },
  { name: "OpenAI API Key", pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/, severity: "critical" },
  { name: "Anthropic API Key", pattern: /\bsk-ant-(api[0-9]+-)?[A-Za-z0-9_-]{40,}\b/, severity: "critical" },
  { name: "Google API Key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "high" },
  { name: "Supabase Service Role Key (JWT)", pattern: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, severity: "high" },
  { name: "Generic Private RSA Key", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, severity: "critical" },
  { name: "Generic JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, severity: "medium" },
];

const FRONTEND_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "PUBLIC_", "EXPO_PUBLIC_", "NUXT_PUBLIC_", "VUE_APP_"];

export const secretsCheck: CheckModule = {
  domain: "secrets",
  description: "Detect leaked credentials, frontend-exposed env vars, committed .env, and bundled secrets.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];
    const toolsUsed: string[] = [];
    const toolsMissing: string[] = [];

    if (!config.repoPath) {
      return {
        domain: "secrets",
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        toolsUsed,
        toolsMissing: ["repo-path-not-provided"],
        findings: [],
        manualChecklist: [
          { item: "Provide --repo to scan for leaked secrets", rationale: "Secrets check requires repo path." },
        ],
      };
    }

    const repo = config.repoPath;

    // ── 1. gitleaks (preferred) ────────────────────────────────
    const gitleaks = whichTool("gitleaks");
    if (gitleaks.available) {
      toolsUsed.push("gitleaks");
      const reportPath = join(config.outDir, "gitleaks.json");
      const res = runCommand(
        "gitleaks",
        ["detect", "--source", repo, "--report-path", reportPath, "--report-format", "json", "--no-banner", "--exit-code", "0"],
        { timeoutMs: 180_000 },
      );
      if (existsSync(reportPath)) {
        try {
          const raw = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
            Description?: string;
            File?: string;
            StartLine?: number;
            Secret?: string;
            RuleID?: string;
            Match?: string;
          }>;
          for (const leak of raw.slice(0, 50)) {
            const isLive = /sk_live_|AKIA|ghp_|sk-ant-|sk-proj-/.test(leak.Match ?? "");
            findings.push({
              id: `secrets.gitleaks.${leak.RuleID ?? "rule"}.${leak.File ?? "f"}.${leak.StartLine ?? 0}`,
              domain: "secrets",
              severity: isLive ? "critical" : "high",
              hardBlocker: isLive,
              title: `Secret detected: ${leak.Description ?? leak.RuleID}`,
              description: `gitleaks flagged a probable secret in \`${leak.File}\` at line ${leak.StartLine}. ${isLive ? "This appears to be a live production credential." : "Verify whether this credential is active before dismissing."}`,
              evidence: [{ file: leak.File, line: leak.StartLine, snippet: redact(leak.Match ?? "") }],
              remediation: [
                "1. Rotate the credential immediately (do not just delete from git — assume it has been scraped).",
                "2. Remove the value from the file and replace with an env-var reference.",
                "3. Rewrite git history if the secret was committed (`git filter-repo`).",
                "4. Add a `.gitignore` entry to keep the file out of future commits.",
              ].join("\n"),
              source: `gitleaks:${leak.RuleID ?? "rule"}`,
              references: ["https://github.com/gitleaks/gitleaks", "https://cwe.mitre.org/data/definitions/798.html"],
            });
          }
        } catch (err) {
          // fall through to regex pass
        }
      }
    } else {
      toolsMissing.push("gitleaks");
    }

    // ── 2. trufflehog (verifier) ────────────────────────────────
    const trufflehog = whichTool("trufflehog");
    if (trufflehog.available) {
      toolsUsed.push("trufflehog");
      const res = runCommand(
        "trufflehog",
        ["filesystem", "--json", "--no-update", "--only-verified", repo],
        { timeoutMs: 120_000 },
      );
      if (res.stdout) {
        const lines = res.stdout.split("\n").filter(Boolean);
        for (const line of lines.slice(0, 25)) {
          try {
            const r = JSON.parse(line);
            findings.push({
              id: `secrets.trufflehog.verified.${r.DetectorName}.${r.SourceMetadata?.Data?.Filesystem?.file ?? "x"}`,
              domain: "secrets",
              severity: "critical",
              hardBlocker: true,
              title: `Verified live secret: ${r.DetectorName}`,
              description: `trufflehog *verified* this credential is currently live against ${r.DetectorName}. Rotate immediately.`,
              evidence: [{
                file: r.SourceMetadata?.Data?.Filesystem?.file,
                line: r.SourceMetadata?.Data?.Filesystem?.line,
                snippet: redact(r.Raw ?? ""),
              }],
              remediation: "Rotate the credential immediately at the provider, then purge from git history.",
              source: `trufflehog:${r.DetectorName}`,
              references: ["https://github.com/trufflesecurity/trufflehog"],
            });
          } catch {}
        }
      }
    } else {
      toolsMissing.push("trufflehog");
    }

    // ── 3. Built-in regex pass (always runs as a safety net) ──
    const targetFiles = walkRepo(repo, (rel) => {
      const base = basename(rel);
      if (base.startsWith(".env")) return true;
      return isSource(rel) || isConfig(rel);
    }, { maxFiles: 3000 });

    for (const { name, pattern, severity } of HIGH_CONFIDENCE_PATTERNS) {
      const hits = grepFiles(targetFiles, pattern, { maxMatches: 20 });
      for (const hit of hits) {
        const key = `secrets.pattern.${slugify(name)}.${hit.file}.${hit.line}`;
        if (findings.some((f) => f.id === key)) continue;
        findings.push({
          id: key,
          domain: "secrets",
          severity,
          hardBlocker: severity === "critical",
          title: `${name} detected in repo`,
          description: `A ${name} was detected at \`${rel(hit.file, repo)}:${hit.line}\`. Even if it is a test key, do not commit secrets.`,
          evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: redact(hit.snippet) }],
          remediation: [
            "1. Move the secret to an environment variable.",
            "2. Rotate the credential — committed secrets are scraped within minutes of being pushed.",
            "3. Purge from git history with `git filter-repo --invert-paths --path-glob '**/.env*'` or similar.",
          ].join("\n"),
          source: "production-ready:regex-pattern",
          references: ["https://owasp.org/www-community/Hardcoded_Credentials", "https://cwe.mitre.org/data/definitions/798.html"],
        });
      }
    }

    // ── 4. Committed .env files ─────────────────────────────────
    const envFiles = walkRepo(repo, (rel) => basename(rel).startsWith(".env") && !basename(rel).includes("example") && !basename(rel).includes("sample"));
    for (const ef of envFiles) {
      const relPath = rel(ef, repo);
      // Check if it's tracked by git
      const gitCheck = runCommand("git", ["ls-files", "--error-unmatch", relPath], { cwd: repo, timeoutMs: 5000 });
      const tracked = gitCheck.status === 0;
      if (tracked) {
        findings.push({
          id: `secrets.committed-env.${relPath}`,
          domain: "secrets",
          severity: "high",
          hardBlocker: false,
          title: `\`.env\` file is tracked in git: ${relPath}`,
          description: "Environment files are commonly committed by mistake and contain live secrets. They should never be tracked.",
          evidence: [{ file: relPath }],
          remediation: [
            "1. `git rm --cached " + relPath + "`",
            "2. Add `" + relPath + "` to `.gitignore`",
            "3. Rotate every secret that was in the file — assume it is compromised",
            "4. Consider rewriting history if the file has been pushed (`git filter-repo`)",
          ].join("\n"),
          source: "production-ready:committed-env",
          references: ["https://12factor.net/config"],
        });
      }
    }

    // ── 5. Frontend-prefixed secrets ────────────────────────────
    const envContentFiles = walkRepo(repo, (rel) => {
      const b = basename(rel);
      return b.startsWith(".env") || b === "vite.config.ts" || b === "vite.config.js" || b === "next.config.js" || b === "next.config.mjs";
    });
    for (const file of envContentFiles) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const prefix of FRONTEND_PREFIXES) {
          if (!line.startsWith(prefix)) continue;
          const lower = line.toLowerCase();
          for (const hint of SECRET_NAME_HINTS) {
            if (lower.includes(hint)) {
              const varName = line.split("=")[0];
              findings.push({
                id: `secrets.frontend-prefix.${rel(file, repo)}.${i + 1}`,
                domain: "secrets",
                severity: "high",
                hardBlocker: true,
                title: `Frontend-exposed env var looks secret: \`${varName}\``,
                description: `Variables prefixed with ${FRONTEND_PREFIXES.join("/")} are *inlined into the browser bundle*. A name containing "${hint}" suggests this is a secret that must not be exposed.`,
                evidence: [{ file: rel(file, repo), line: i + 1, snippet: redact(line) }],
                remediation: [
                  "1. Move this value to a server-side env var (no frontend prefix).",
                  "2. Access it from an API route / server action — never from client code.",
                  "3. If a public token is required (e.g., Supabase anon key, Stripe publishable key), confirm it is *intended* to be public per the provider's docs.",
                  "4. Rotate the existing value — assume the browser bundle has been scraped.",
                ].join("\n"),
                source: "production-ready:frontend-prefix",
                references: ["https://nextjs.org/docs/pages/api-reference/next-config-js/env", "https://vitejs.dev/guide/env-and-mode.html"],
              });
              break;
            }
          }
        }
      }
    }

    // ── 6. Bundled secret leakage (dist/build/.next) ────────────
    const buildDirs = ["dist", "build", ".next/static", "out", ".output/public", ".vercel/output/static"]
      .map((d) => join(repo, d))
      .filter((d) => existsSync(d));
    if (buildDirs.length === 0) {
      // No build directory — note for manual
    } else {
      const bundleFiles: string[] = [];
      for (const bd of buildDirs) {
        bundleFiles.push(...walkRepo(bd, (rel) => rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".html"), { maxFiles: 500, maxBytes: 5 * 1024 * 1024 }));
      }
      for (const { name, pattern, severity } of HIGH_CONFIDENCE_PATTERNS) {
        const hits = grepFiles(bundleFiles, pattern, { maxMatches: 5 });
        for (const hit of hits) {
          findings.push({
            id: `secrets.bundle-leak.${slugify(name)}.${rel(hit.file, repo)}.${hit.line}`,
            domain: "secrets",
            severity: "critical",
            hardBlocker: true,
            title: `Secret in built bundle: ${name}`,
            description: `A ${name} was found inside compiled output at \`${rel(hit.file, repo)}\`. This means it has been shipped to every browser that loaded your site.`,
            evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: redact(hit.snippet) }],
            remediation: [
              "1. **Rotate immediately.** The credential is in production browsers right now.",
              "2. Audit how this value reached the client bundle — likely a `NEXT_PUBLIC_` / `VITE_` env var or a server-only constant imported into a client component.",
              "3. Move the secret to a server-only path; route client requests through your own API.",
              "4. Re-deploy with sourcemaps disabled (or behind auth).",
            ].join("\n"),
            source: "production-ready:bundle-leak",
            references: ["https://owasp.org/Top10/A02_2021-Cryptographic_Failures/"],
          });
        }
      }
      toolsUsed.push("production-ready:bundle-scan");
    }

    return {
      domain: "secrets",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed,
      toolsMissing,
      findings,
      manualChecklist: [
        { item: "Confirm publishable/anon keys are documented as intentionally-public by the provider", rationale: "Some 'public' keys are safe to expose (Stripe publishable, Supabase anon); others are not." },
        { item: "Verify credential rotation cadence is defined and tested", rationale: "Even unleaked credentials should be rotated periodically." },
        { item: "Check provider audit logs for unexpected access", rationale: "Past leaks may have been exploited." },
      ],
    };
  },
};

function redact(s: string): string {
  return s.replace(/([A-Za-z0-9_-]{10,})/g, (m) => (m.length > 14 ? m.slice(0, 6) + "…" + m.slice(-4) : m)).slice(0, 200);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function rel(full: string, root: string): string {
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}
