/**
 * Coverage assessment — the fix for the "false green" bug.
 *
 * A verdict computed only from findings answers "did we find problems?" but
 * silently conflates "we looked and it's clean" with "we couldn't look." An
 * audit that ran with eight of nine scanners missing, no URL, and every
 * critical manual check unverified must NOT be able to return Launch-Ready.
 *
 * This module computes a coverage *ceiling*: the best verdict the audit is
 * allowed to reach given what it actually managed to inspect. The orchestrator
 * then takes `worst(findingsVerdict, coverageCeiling)`.
 */

import type {
  AuditConfig,
  CheckResult,
  CoverageReport,
  CoverageGap,
  CoverageStatus,
  DomainCoverage,
  Domain,
  Verdict,
} from "./types.ts";

/** Scanners we consider part of a complete audit. */
export const CORE_SCANNERS = ["gitleaks", "semgrep", "osv-scanner"] as const;

/**
 * Domains where "not audited" is a launch-blocking blind spot rather than a
 * nice-to-have. Missing coverage here caps harder (private-beta-only).
 */
const SECURITY_CRITICAL_DOMAINS = new Set<Domain>([
  "secrets",
  "authentication",
  "api-safety",
  "owasp",
  "payments",
]);

const VERDICT_RANK: Record<Verdict, number> = {
  "launch-ready": 0,
  "launch-with-monitoring": 1,
  "private-beta-only": 2,
  "do-not-launch": 3,
};

/** Return the more severe (worse) of two verdicts. */
export function worst(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

type RiskProfile = "startup-mvp" | "standard" | "regulated";

/**
 * The verdict a coverage gap caps at, tuned by risk profile:
 *   - startup-mvp: lenient — even a blind audit only caps at monitoring
 *     (but an incomplete audit is still never launch-ready).
 *   - standard:    blocking → private-beta, soft → monitoring.
 *   - regulated:   strict — any gap caps at private-beta.
 */
function gapCeiling(g: CoverageGap, profile: RiskProfile): Verdict {
  if (profile === "startup-mvp") return "launch-with-monitoring";
  if (profile === "regulated") return "private-beta-only";
  return g.severity === "blocking" ? "private-beta-only" : "launch-with-monitoring";
}

/**
 * Infer coverage for a check that did not explicitly declare it. Conservative:
 * an errored domain is "not-run"; a domain that used no tools while some were
 * missing is "partial"; otherwise "pass".
 */
export function inferCoverage(r: CheckResult): DomainCoverage {
  if (r.coverage) return r.coverage;
  if (r.error) return { status: "not-run", reason: r.error };
  if (r.toolsMissing.length > 0 && r.toolsUsed.length === 0) {
    return { status: "partial", reason: `ran without ${r.toolsMissing.join(", ")}` };
  }
  return { status: "pass" };
}

export interface CoverageInput {
  results: CheckResult[];
  tooling: Record<string, { available: boolean }>;
  config: AuditConfig;
}

export function assessCoverage({ results, tooling, config }: CoverageInput): CoverageReport {
  const perDomain: CoverageReport["perDomain"] = [];
  const gaps: CoverageGap[] = [];

  // ── 1. Per-domain coverage (errors, self-declared fail/partial) ──
  for (const r of results) {
    const cov = inferCoverage(r);
    perDomain.push({ domain: r.domain, status: cov.status, reason: cov.reason });

    const critical = SECURITY_CRITICAL_DOMAINS.has(r.domain);
    if (cov.status === "not-run") {
      gaps.push({
        kind: `domain:${r.domain}:not-run`,
        severity: critical ? "blocking" : "soft",
        detail: `${r.domain} did not complete${cov.reason ? ` — ${cov.reason}` : ""}`,
      });
    } else if (cov.status === "fail") {
      gaps.push({
        kind: `domain:${r.domain}:no-coverage`,
        severity: critical ? "blocking" : "soft",
        detail: `${r.domain} could not be exercised${cov.reason ? ` — ${cov.reason}` : ""}`,
      });
    } else if (cov.status === "partial") {
      gaps.push({
        kind: `domain:${r.domain}:partial`,
        severity: "soft",
        detail: `${r.domain} ran with reduced coverage${cov.reason ? ` — ${cov.reason}` : ""}`,
      });
    }
  }

  // ── 2. Core scanner availability ──
  const missingScanners = CORE_SCANNERS.filter((s) => !tooling[s]?.available);
  if (missingScanners.length >= 2) {
    // The audit is substantially blind — most external verification is absent.
    gaps.push({
      kind: "scanners:multiple-missing",
      severity: "blocking",
      detail: `${missingScanners.length} core scanners unavailable (${missingScanners.join(", ")}) — external verification is largely absent; only in-process heuristics ran`,
    });
  } else if (missingScanners.length === 1) {
    gaps.push({
      kind: `scanner:${missingScanners[0]}:missing`,
      severity: "soft",
      detail: `${missingScanners[0]} unavailable — its domain relied on in-process heuristics only`,
    });
  }

  // ── 3. Unverified critical manual checks ──
  const criticalManual = results.flatMap((r) => r.manualChecklist.filter((m) => m.critical));
  if (criticalManual.length > 0 && config.manualVerified !== true) {
    gaps.push({
      kind: "manual:critical-unverified",
      severity: "soft",
      detail: `${criticalManual.length} critical manual check(s) not signed off — pass --manual-verified after a human confirms them`,
    });
  }

  // ── Ceiling = worst cap across all gaps (tuned by risk profile) ──
  const profile: RiskProfile = config.policy?.riskProfile ?? "standard";
  let ceiling: Verdict = "launch-ready";
  for (const g of gaps) ceiling = worst(ceiling, gapCeiling(g, profile));

  return {
    perDomain,
    gaps,
    missingScanners: [...missingScanners],
    ceiling,
    incomplete: ceiling !== "launch-ready",
  };
}

export const COVERAGE_ICON: Record<CoverageStatus, string> = {
  pass: "✅",
  partial: "🟡",
  fail: "🔴",
  "not-run": "⚫",
};

export const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  pass: "Full",
  partial: "Partial",
  fail: "None",
  "not-run": "Not run",
};
