import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AXIOM_VEIL_COMPARABLE_ROUND,
  AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE,
  AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE,
  type ScoreReportInput,
} from "./game-score-lineage";
import {
  gameScoreGateMode,
  gameScorePreflightSummary,
  runGameScorePreflight,
} from "./game-score-preflight";

function writeReport(report: unknown, name = "score-report.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "game-score-"));
  const path = join(dir, name);
  writeFileSync(path, typeof report === "string" ? report : JSON.stringify(report), "utf8");
  return path;
}

function enforce(path: string | null): Record<string, string | undefined> {
  return {
    FACTORY_GAME_SCORE_GATE: "1",
    ...(path ? { FACTORY_GAME_SCORE_REPORT_PATH: path } : {}),
  };
}

describe("game score gate mode", () => {
  test("defaults to off", () => {
    expect(gameScoreGateMode({})).toBe("off");
    expect(gameScoreGateMode({ FACTORY_GAME_SCORE_GATE: "0" })).toBe("off");
    expect(gameScoreGateMode({ FACTORY_GAME_SCORE_GATE: "off" })).toBe("off");
  });

  test("accepts the enforce spellings and rejects anything else", () => {
    expect(gameScoreGateMode({ FACTORY_GAME_SCORE_GATE: "1" })).toBe("enforce");
    expect(gameScoreGateMode({ FACTORY_GAME_SCORE_GATE: "ENFORCE" })).toBe("enforce");
    expect(() => gameScoreGateMode({ FACTORY_GAME_SCORE_GATE: "shadow" })).toThrow(/Invalid FACTORY_GAME_SCORE_GATE/);
  });
});

describe("game score preflight", () => {
  test("is a no-op when disabled", () => {
    const result = runGameScorePreflight({});
    expect(result).toEqual({ mode: "off", allowed: true, reportPath: null, report: null, reason: "disabled" });
    expect(gameScorePreflightSummary(result)).toBe("off allowed reason=disabled");
  });

  test("fails closed when the report is missing or unusable", () => {
    expect(runGameScorePreflight(enforce(null)).reason).toBe("missing-report-path");
    expect(runGameScorePreflight({ ...enforce(null), FACTORY_GAME_SCORE_REPORT_PATH: "relative.json" }).reason).toBe(
      "report-path-not-absolute",
    );
    expect(
      runGameScorePreflight({ ...enforce(null), FACTORY_GAME_SCORE_REPORT_PATH: "/nope/score-report.json" }).reason,
    ).toBe("report-path-not-found");
    expect(runGameScorePreflight(enforce(writeReport("[]"))).reason).toBe("report-not-a-mapping");
    expect(runGameScorePreflight(enforce(writeReport("{not json"))).reason).toMatch(/^report-unreadable:/);
  });

  test("fails closed on a structurally incomplete report", () => {
    const partial = { ...AXIOM_VEIL_COMPARABLE_ROUND } as Partial<ScoreReportInput>;
    delete partial.scores;
    expect(runGameScorePreflight(enforce(writeReport(partial))).reason).toBe("report-missing-scores");

    const noEvidenceFlag = { ...AXIOM_VEIL_COMPARABLE_ROUND } as Partial<ScoreReportInput>;
    delete noEvidenceFlag.evidenceValid;
    expect(runGameScorePreflight(enforce(writeReport(noEvidenceFlag))).reason).toBe("report-missing-evidenceValid");

    const noBaseline = { ...AXIOM_VEIL_COMPARABLE_ROUND, frozenBaselineCandidateDigest: "" };
    expect(runGameScorePreflight(enforce(writeReport(noBaseline))).reason).toBe(
      "report-missing-frozenBaselineCandidateDigest",
    );
  });

  test("rejects a report whose contract version is unknown", () => {
    const path = writeReport({ ...AXIOM_VEIL_COMPARABLE_ROUND, contractVersion: 2 });
    const result = runGameScorePreflight(enforce(path));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("report-rejected:unknown-version");
  });

  test("allows a comparable round and reports hard-lane status", () => {
    const result = runGameScorePreflight(enforce(writeReport(AXIOM_VEIL_COMPARABLE_ROUND)));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("comparable");
    expect(result.report?.reportableDeltas).toHaveLength(1);
    expect(result.report?.promotionBlocked).toBe(true);
    const summary = gameScorePreflightSummary(result);
    expect(summary).toContain("deltas=1/1");
    expect(summary).toContain("hard-lane-failures=first-party-visual-parity");
    expect(summary).toContain("closure=hard-lane-failure");
  });

  test("blocks composite-to-visual substitution", () => {
    const result = runGameScorePreflight(enforce(writeReport(AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE)));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("invalid-score-lineage");
    expect(result.report?.terminalState).toBe("INVALID_EVIDENCE");
    expect(gameScorePreflightSummary(result)).toContain("composite-to-visual-substitution");
  });

  test("blocks a lineage change that never rescored the frozen baseline", () => {
    const result = runGameScorePreflight(enforce(writeReport(AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE)));
    expect(result.allowed).toBe(false);
    expect(result.report?.scoresSuppressed).toBe(true);
    expect(gameScorePreflightSummary(result)).toContain("missing-baseline-rescore");
  });

  test("reads a YAML report", () => {
    const yaml = [
      "contractVersion: 1",
      "candidateId: axiom-veil-vertical-slice",
      `candidateDigest: ${AXIOM_VEIL_COMPARABLE_ROUND.candidateDigest}`,
      `frozenBaselineCandidateDigest: ${AXIOM_VEIL_COMPARABLE_ROUND.frozenBaselineCandidateDigest}`,
      "evidenceValid: true",
      "requiredHardLenses:",
      "  - first-party-visual-parity",
      `scores: ${JSON.stringify(AXIOM_VEIL_COMPARABLE_ROUND.scores)}`,
      `deltas: ${JSON.stringify(AXIOM_VEIL_COMPARABLE_ROUND.deltas)}`,
      "",
    ].join("\n");
    const result = runGameScorePreflight(enforce(writeReport(yaml, "score-report.yaml")));
    expect(result.allowed).toBe(true);
    expect(result.report?.closure.derivedFrom).toBe("hard-lane-status");
  });
});
