import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  evaluateScoreReport,
  GameScoreContractViolation,
  type ScoreReport,
  type ScoreReportInput,
} from "./game-score-lineage";

export type GameScoreGateMode = "off" | "enforce";

export interface GameScorePreflightResult {
  mode: GameScoreGateMode;
  allowed: boolean;
  reportPath: string | null;
  report: ScoreReport | null;
  reason: string;
}

export function gameScoreGateMode(env: Record<string, string | undefined> = process.env): GameScoreGateMode {
  const raw = env.FACTORY_GAME_SCORE_GATE?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off") return "off";
  if (raw === "1" || raw === "enforce") return "enforce";
  throw new Error(`Invalid FACTORY_GAME_SCORE_GATE value: ${raw}`);
}

function blocked(mode: GameScoreGateMode, reportPath: string | null, reason: string): GameScorePreflightResult {
  return { mode, allowed: false, reportPath, report: null, reason };
}

export function runGameScorePreflight(
  env: Record<string, string | undefined> = process.env,
): GameScorePreflightResult {
  const mode = gameScoreGateMode(env);
  if (mode === "off") {
    return { mode, allowed: true, reportPath: null, report: null, reason: "disabled" };
  }

  const reportPath = env.FACTORY_GAME_SCORE_REPORT_PATH?.trim() ?? "";
  if (!reportPath) return blocked(mode, null, "missing-report-path");
  if (!isAbsolute(reportPath)) return blocked(mode, reportPath, "report-path-not-absolute");
  if (!existsSync(reportPath)) return blocked(mode, reportPath, "report-path-not-found");

  let parsed: unknown;
  try {
    const contents = readFileSync(reportPath, "utf8");
    parsed = contents.trimStart().startsWith("{") ? JSON.parse(contents) : Bun.YAML.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return blocked(mode, reportPath, `report-unreadable:${detail}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return blocked(mode, reportPath, "report-not-a-mapping");
  }

  const candidate = parsed as Partial<ScoreReportInput>;
  for (const key of ["scores", "deltas", "requiredHardLenses"] as const) {
    if (!Array.isArray(candidate[key])) return blocked(mode, reportPath, `report-missing-${key}`);
  }
  for (const key of ["candidateDigest", "frozenBaselineCandidateDigest"] as const) {
    const value = candidate[key];
    if (typeof value !== "string" || !value.trim()) return blocked(mode, reportPath, `report-missing-${key}`);
  }
  if (typeof candidate.evidenceValid !== "boolean") return blocked(mode, reportPath, "report-missing-evidenceValid");

  let report: ScoreReport;
  try {
    report = evaluateScoreReport(candidate as ScoreReportInput);
  } catch (error) {
    if (error instanceof GameScoreContractViolation) {
      return blocked(mode, reportPath, `report-rejected:${error.violations.map((v) => v.code).join(",")}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return blocked(mode, reportPath, `report-rejected:${detail}`);
  }

  return {
    mode,
    allowed: report.valid,
    reportPath,
    report,
    reason: report.valid ? "comparable" : "invalid-score-lineage",
  };
}

export function gameScorePreflightSummary(result: GameScorePreflightResult): string {
  const report = result.report;
  if (!report) return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}`;
  const codes = [...new Set(report.violations.map((violation) => violation.code))];
  const failedLanes = report.hardLanes.filter((lane) => !lane.passed).map((lane) => lane.lensId);
  return (
    `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}` +
    ` state=${report.terminalState ?? "none"} scores=${report.scoresSuppressed ? "suppressed" : "eligible"}` +
    ` promotion=${report.promotionBlocked ? "blocked" : "eligible"}` +
    ` deltas=${report.reportableDeltas.length}/${report.deltas.length}` +
    ` hard-lane-failures=${failedLanes.length ? failedLanes.join(",") : "none"}` +
    ` closure=${report.closure.verdict} violations=${codes.length ? codes.join(",") : "none"}`
  );
}
