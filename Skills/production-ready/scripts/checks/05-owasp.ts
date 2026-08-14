/**
 * Domain 5: OWASP Baseline
 *
 *  - semgrep p/owasp-top-ten + p/secrets + p/xss + p/sqli
 *  - osv-scanner for vulnerable deps
 *  - nuclei + security headers when URL provided
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { runCommand, whichTool } from "../lib/runners.ts";

export const owaspCheck: CheckModule = {
  domain: "owasp",
  description: "OWASP Top 10 sweep — SAST, SCA, DAST, headers.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];
    const toolsUsed: string[] = [];
    const toolsMissing: string[] = [];

    // ── semgrep OWASP rules ─────────────────────────────────────
    if (config.repoPath) {
      const semgrep = whichTool("semgrep");
      if (semgrep.available) {
        toolsUsed.push("semgrep");
        const res = runCommand(
          "semgrep",
          ["--config", "p/owasp-top-ten", "--config", "p/xss", "--config", "p/sql-injection", "--severity", "ERROR", "--severity", "WARNING", "--json", "--quiet", config.repoPath],
          { timeoutMs: 300_000 },
        );
        if (res.stdout) {
          try {
            const j = JSON.parse(res.stdout);
            for (const r of (j.results ?? []).slice(0, 40)) {
              const sev = r.extra?.severity === "ERROR" ? "high" : "medium";
              findings.push({
                id: `owasp.semgrep.${r.check_id}.${(r.path ?? "x").replace(/\//g, "_")}.${r.start?.line ?? 0}`,
                domain: "owasp",
                severity: sev,
                title: `Semgrep: ${r.check_id}`,
                description: r.extra?.message ?? "Semgrep flagged an OWASP-class issue.",
                evidence: [{ file: rel(r.path, config.repoPath), line: r.start?.line, snippet: (r.extra?.lines ?? "").trim().slice(0, 200) }],
                remediation: r.extra?.fix ?? "Review the flagged line and apply the standard OWASP mitigation.",
                source: `semgrep:${r.check_id}`,
                references: r.extra?.metadata?.references ?? [],
              });
            }
          } catch {}
        }
      } else {
        toolsMissing.push("semgrep");
      }

      // ── osv-scanner ─────────────────────────────────────────────
      const osv = whichTool("osv-scanner");
      if (osv.available) {
        toolsUsed.push("osv-scanner");
        const res = runCommand(
          "osv-scanner",
          ["scan", "source", "-r", config.repoPath, "--format", "json"],
          { timeoutMs: 180_000 },
        );
        if (res.stdout) {
          try {
            const j = JSON.parse(res.stdout);
            for (const result of j.results ?? []) {
              for (const pkg of result.packages ?? []) {
                for (const vuln of pkg.vulnerabilities ?? []) {
                  const sev = mapOsvSeverity(vuln.severity);
                  findings.push({
                    id: `owasp.osv.${vuln.id}.${pkg.package?.name}`,
                    domain: "owasp",
                    severity: sev,
                    hardBlocker: sev === "critical",
                    title: `${vuln.id}: vulnerable dependency ${pkg.package?.name}@${pkg.package?.version}`,
                    description: vuln.summary ?? "Known vulnerability in a dependency.",
                    evidence: [{ file: result.source?.path, snippet: `${pkg.package?.name}@${pkg.package?.version}` }],
                    remediation: `Upgrade \`${pkg.package?.name}\` to a fixed version. See ${vuln.id} on osv.dev for the patched range.`,
                    source: "osv-scanner",
                    references: [`https://osv.dev/vulnerability/${vuln.id}`],
                  });
                }
              }
            }
          } catch {}
        }
      } else {
        toolsMissing.push("osv-scanner");
      }

      // ── trivy filesystem (additional CVE source) ────────────────
      const trivy = whichTool("trivy");
      if (trivy.available && !toolsUsed.includes("osv-scanner")) {
        toolsUsed.push("trivy");
        const res = runCommand(
          "trivy",
          ["fs", "--format", "json", "--severity", "HIGH,CRITICAL", "--quiet", config.repoPath],
          { timeoutMs: 240_000 },
        );
        if (res.stdout) {
          try {
            const j = JSON.parse(res.stdout);
            for (const result of (j.Results ?? []).slice(0, 5)) {
              for (const vuln of (result.Vulnerabilities ?? []).slice(0, 20)) {
                findings.push({
                  id: `owasp.trivy.${vuln.VulnerabilityID}.${vuln.PkgName}`,
                  domain: "owasp",
                  severity: vuln.Severity === "CRITICAL" ? "critical" : "high",
                  hardBlocker: vuln.Severity === "CRITICAL",
                  title: `${vuln.VulnerabilityID}: ${vuln.PkgName}@${vuln.InstalledVersion}`,
                  description: vuln.Title ?? vuln.Description?.slice(0, 200),
                  evidence: [{ file: result.Target, snippet: `${vuln.PkgName}@${vuln.InstalledVersion}` }],
                  remediation: `Upgrade to ${vuln.FixedVersion ?? "patched version"}.`,
                  source: "trivy",
                  references: vuln.References ?? [],
                });
              }
            }
          } catch {}
        }
      }
    }

    // ── nuclei (URL only) ───────────────────────────────────────
    if (config.url) {
      const nuclei = whichTool("nuclei");
      if (nuclei.available) {
        toolsUsed.push("nuclei");
        const res = runCommand(
          "nuclei",
          ["-u", config.url, "-severity", "critical,high,medium", "-jsonl", "-silent", "-disable-update-check"],
          { timeoutMs: 300_000 },
        );
        if (res.stdout) {
          for (const line of res.stdout.split("\n").slice(0, 50)) {
            if (!line.trim()) continue;
            try {
              const r = JSON.parse(line);
              const sev = mapSeverity(r.info?.severity);
              findings.push({
                id: `owasp.nuclei.${r.template_id}.${r["matched-at"]}`,
                domain: "owasp",
                severity: sev,
                hardBlocker: sev === "critical",
                title: `Nuclei: ${r.info?.name ?? r.template_id}`,
                description: r.info?.description ?? "Nuclei detected a vulnerability or misconfiguration.",
                evidence: [{ url: r["matched-at"] ?? config.url, snippet: r["matcher-name"] }],
                remediation: r.info?.remediation ?? "Review the template documentation linked below.",
                source: `nuclei:${r.template_id}`,
                references: r.info?.reference ?? [],
              });
            } catch {}
          }
        }
      } else {
        toolsMissing.push("nuclei");
      }

      // ── security headers ────────────────────────────────────────
      toolsUsed.push("production-ready:headers");
      try {
        const headRes = await fetch(config.url, { method: "GET", redirect: "follow" }).catch(() => null);
        if (headRes) {
          const required: Array<{ name: string; expected: RegExp; severity: "high" | "medium"; desc: string }> = [
            { name: "strict-transport-security", expected: /max-age=\d+/, severity: "high", desc: "HSTS — forces HTTPS, prevents downgrade attacks." },
            { name: "content-security-policy", expected: /./, severity: "high", desc: "CSP — defence-in-depth against XSS and data injection." },
            { name: "x-content-type-options", expected: /nosniff/i, severity: "medium", desc: "Prevents MIME-type sniffing-based attacks." },
            { name: "referrer-policy", expected: /./, severity: "medium", desc: "Controls how much referrer info downstream sites see." },
            { name: "permissions-policy", expected: /./, severity: "medium", desc: "Restricts browser APIs the app can use." },
          ];
          for (const h of required) {
            const val = headRes.headers.get(h.name);
            if (!val || !h.expected.test(val)) {
              findings.push({
                id: `owasp.header-missing.${h.name}`,
                domain: "owasp",
                severity: h.severity,
                title: `Security header missing or malformed: ${h.name}`,
                description: h.desc + (val ? ` Current value: \`${val}\`.` : " Header was not set."),
                evidence: [{ url: config.url }],
                remediation: `Set \`${h.name}\` at your reverse proxy / framework. See \`references/tool-reference.md\` for production-grade values.`,
                source: "production-ready:headers",
                references: ["https://owasp.org/www-project-secure-headers/"],
              });
            }
          }
        }
      } catch {}
    }

    return {
      domain: "owasp",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed,
      toolsMissing,
      findings,
      manualChecklist: [
        { item: "Threat-model the auth boundary: what does a malicious authenticated user gain access to?", rationale: "OWASP A04 (Insecure Design) cannot be detected by scanners — needs human judgement." },
        { item: "Review every dependency added in the last 6 months for typosquatting / abandoned-maintainer risk", rationale: "Supply-chain attacks (A08) target recently-added or unmaintained packages." },
        { item: "Run a real DAST (ZAP full scan) at least once before launch and after every major release", rationale: "Static analysis cannot replicate exploit paths." },
      ],
    };
  },
};

function rel(full: string | undefined, root: string | undefined): string {
  if (!full || !root) return full ?? "";
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}

function mapSeverity(s: string | undefined): "critical" | "high" | "medium" | "low" | "info" {
  switch ((s ?? "").toLowerCase()) {
    case "critical": return "critical";
    case "high": return "high";
    case "medium": return "medium";
    case "low": return "low";
    default: return "info";
  }
}

function mapOsvSeverity(severities: any): "critical" | "high" | "medium" | "low" | "info" {
  if (!Array.isArray(severities)) return "medium";
  for (const s of severities) {
    if (s.type === "CVSS_V3" || s.type === "CVSS_V4") {
      const score = parseFloat((s.score ?? "").split("/")[0]);
      if (score >= 9) return "critical";
      if (score >= 7) return "high";
      if (score >= 4) return "medium";
      return "low";
    }
  }
  return "medium";
}
