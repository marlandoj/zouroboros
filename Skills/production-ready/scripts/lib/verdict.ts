/**
 * Compute the launch verdict.
 *
 * Two independent gates, and the verdict is the WORSE of the two:
 *
 *  1. Findings gate — what problems did we find?
 *       🔴 do-not-launch          — any critical / hard blocker
 *       🟠 private-beta-only      — 1+ high
 *       🟡 launch-with-monitoring — > 3 medium
 *       🟢 launch-ready           — 0 critical, 0 high, ≤ 3 medium
 *
 *  2. Coverage gate — did we actually look? An incomplete audit (missing
 *     scanners, no URL, errored domains, unverified critical manual checks)
 *     caps the verdict below launch-ready. A clean-but-blind scan is NOT
 *     launch-ready; that is the whole point of this gate.
 */

import type { Finding, Verdict, Severity, CoverageReport } from "./types.ts";
import { worst } from "./coverage.ts";

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
  exitCode: number;
  scores: Record<Severity, number> & { total: number };
  hardBlockers: Finding[];
  /** Verdict from findings alone, before the coverage ceiling was applied. */
  findingsVerdict: Verdict;
  /** Best verdict coverage allowed (launch-ready when coverage is complete). */
  coverageCeiling: Verdict;
  /** True when the coverage ceiling (not findings) determined the outcome. */
  cappedByCoverage: boolean;
}

const EXIT_CODE: Record<Verdict, number> = {
  "launch-ready": 0,
  "launch-with-monitoring": 1,
  "private-beta-only": 2,
  "do-not-launch": 3,
};

function findingsGate(
  scores: Record<Severity, number>,
  hardBlockers: Finding[],
  maxMedium: number,
): { verdict: Verdict; reason: string } {
  if (hardBlockers.length > 0) {
    return {
      verdict: "do-not-launch",
      reason: `${hardBlockers.length} hard blocker(s) and/or critical finding(s) detected`,
    };
  }
  if (scores.high > 0) {
    return {
      verdict: "private-beta-only",
      reason: `${scores.high} high-severity finding(s) — invite-gated launch acceptable`,
    };
  }
  if (scores.medium > maxMedium) {
    return {
      verdict: "launch-with-monitoring",
      reason: `${scores.medium} medium-severity findings (threshold ${maxMedium}) — track post-launch`,
    };
  }
  return {
    verdict: "launch-ready",
    reason: "No critical or high findings; medium findings within threshold",
  };
}

export function computeVerdict(
  findings: Finding[],
  coverage?: CoverageReport,
  opts: { maxMedium?: number } = {},
): VerdictResult {
  const scores: Record<Severity, number> & { total: number } = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    total: findings.length,
  };
  const hardBlockers: Finding[] = [];

  for (const f of findings) {
    scores[f.severity] += 1;
    if (f.hardBlocker || f.severity === "critical") hardBlockers.push(f);
  }

  const fg = findingsGate(scores, hardBlockers, opts.maxMedium ?? 3);
  const coverageCeiling: Verdict = coverage?.ceiling ?? "launch-ready";
  const finalVerdict = worst(fg.verdict, coverageCeiling);
  const cappedByCoverage = finalVerdict !== fg.verdict;

  let reason = fg.reason;
  if (cappedByCoverage) {
    const gapNote = coverage?.gaps.length
      ? `: ${coverage.gaps.map((g) => g.detail).slice(0, 3).join("; ")}${coverage.gaps.length > 3 ? "; …" : ""}`
      : "";
    reason = `Findings alone would be "${fg.verdict}", but the audit was incomplete${gapNote}. Capped at "${finalVerdict}" until coverage gaps are closed.`;
  }

  return {
    verdict: finalVerdict,
    reason,
    exitCode: EXIT_CODE[finalVerdict],
    scores,
    hardBlockers,
    findingsVerdict: fg.verdict,
    coverageCeiling,
    cappedByCoverage,
  };
}

export const VERDICT_EMOJI: Record<Verdict, string> = {
  "launch-ready": "🟢",
  "launch-with-monitoring": "🟡",
  "private-beta-only": "🟠",
  "do-not-launch": "🔴",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  "launch-ready": "Launch-Ready",
  "launch-with-monitoring": "Launch with Monitoring",
  "private-beta-only": "Private Beta Only",
  "do-not-launch": "Do Not Launch",
};
