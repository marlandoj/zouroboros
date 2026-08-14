/**
 * Domain 1: Legal & Data Handling
 *
 *  - Privacy policy / terms presence
 *  - Data retention / deletion / export capability
 *  - Third-party data-sharing disclosures
 *  - GDPR / CCPA hooks
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource } from "../lib/runners.ts";

export const legalCheck: CheckModule = {
  domain: "legal",
  description: "Verify privacy/terms surfaces and data-rights endpoints exist.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];
    const manualChecklist: CheckResult["manualChecklist"] = [];

    if (!config.repoPath) {
      return emptyResult("legal", startedAt, "Repo path required to scan legal/privacy surfaces.");
    }

    const repo = config.repoPath;

    // Look for privacy/terms surfaces
    const surfaces = ["privacy", "terms", "tos", "policy", "gdpr", "ccpa", "cookies", "data-rights"];
    const candidateFiles = walkRepo(repo, (rel) => {
      const lower = rel.toLowerCase();
      return surfaces.some((s) => lower.includes(s)) && (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".html") || lower.endsWith(".tsx") || lower.endsWith(".jsx") || lower.endsWith(".vue") || lower.endsWith(".svelte"));
    }, { maxFiles: 200 });

    const found = new Set<string>();
    for (const f of candidateFiles) {
      for (const s of surfaces) {
        if (f.toLowerCase().includes(s)) found.add(s);
      }
    }

    if (!found.has("privacy") && !found.has("policy")) {
      findings.push({
        id: "legal.missing-privacy-policy",
        domain: "legal",
        severity: config.surfaces?.userData ? "high" : "medium",
        title: "No privacy policy page found",
        description: "No file or route resembling a privacy policy was detected. Apps that collect user data need a published, accessible privacy policy.",
        remediation: "Add `/privacy` (or similar) describing what data you collect, why, how long it's retained, third parties it's shared with, and how users can export/delete it.",
        source: "production-ready:repo-grep",
        references: ["https://gdpr.eu/article-13-notice/", "https://oag.ca.gov/privacy/ccpa"],
      });
    }

    if (!found.has("terms") && !found.has("tos")) {
      findings.push({
        id: "legal.missing-terms",
        domain: "legal",
        severity: "medium",
        title: "No terms of service found",
        description: "No file or route resembling Terms of Service was detected. Public-facing apps should publish ToS limiting liability and defining acceptable use.",
        remediation: "Add `/terms` covering acceptable use, liability disclaimers, dispute resolution, and termination conditions.",
        source: "production-ready:repo-grep",
      });
    }

    // Search for data-rights endpoints
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 3000 });
    const dataRightsPatterns = [
      /\/api\/(export|account-export|data-export|user-export)/i,
      /\.(get|post)\(\s*["'][^"']*\/export(?:["'/?]|$)/i,
      /\/api\/(delete-account|account\/delete|user\/delete|gdpr\/delete)/i,
      /right-to-(erasure|delete|forget|export|portability)/i,
    ];
    let foundExport = false, foundDelete = false;
    for (const p of dataRightsPatterns) {
      const hits = grepFiles(sourceFiles, p, { maxMatches: 5 });
      if (hits.length) {
        if (/export|portability/i.test(p.source)) foundExport = true;
        if (/delete|erasure|forget/i.test(p.source)) foundDelete = true;
      }
    }
    if (config.surfaces?.userData) {
      if (!foundExport) {
        findings.push({
          id: "legal.no-data-export",
          domain: "legal",
          severity: "high",
          title: "No data export endpoint detected",
          description: "GDPR Article 20 (right to data portability) and CCPA both require a way for users to obtain their data in a machine-readable format.",
          remediation: "Implement a `/account/export` endpoint that returns the user's records as JSON or CSV. Verify it returns all data, including data held by sub-processors.",
          source: "production-ready:repo-grep",
          references: ["https://gdpr.eu/article-20-right-to-data-portability/"],
        });
      }
      if (!foundDelete) {
        findings.push({
          id: "legal.no-account-deletion",
          domain: "legal",
          severity: "high",
          hardBlocker: false,
          title: "No account deletion endpoint detected",
          description: "GDPR Article 17 (right to erasure) and CCPA both grant users the right to delete their account and data.",
          remediation: "Implement an in-product 'Delete my account' flow that confirms identity, runs a destructive delete (or anonymizes), and confirms by email. Document retention exceptions (e.g., financial records).",
          source: "production-ready:repo-grep",
          references: ["https://gdpr.eu/article-17-right-to-be-forgotten/"],
        });
      }
    }

    manualChecklist.push(
      { item: "List every third party that receives user data (analytics, error reporting, LLM providers, payment processors)", rationale: "Required for GDPR/CCPA disclosure and Data Processing Agreements." },
      { item: "Define data retention windows per data type", rationale: "Indefinite retention is hostile to user privacy and increases breach blast radius." },
      { item: "Verify Data Processing Agreement (DPA) signed with each sub-processor", rationale: "GDPR Article 28 requires DPAs with processors handling personal data." },
      { item: "Cookie banner / consent management is wired (if EU/UK users)", rationale: "GDPR + ePrivacy Directive require informed consent for non-essential cookies." },
      { item: "Privacy policy lists all processors + retention windows + lawful basis", rationale: "Plain-language disclosure is legally required, not optional." },
    );

    return {
      domain: "legal",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:repo-grep"],
      toolsMissing: [],
      findings,
      manualChecklist,
    };
  },
};

function emptyResult(domain: any, startedAt: number, note: string): CheckResult {
  return {
    domain,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    toolsUsed: [],
    toolsMissing: [],
    findings: [],
    manualChecklist: [{ item: note, rationale: "Check could not run." }],
  };
}
