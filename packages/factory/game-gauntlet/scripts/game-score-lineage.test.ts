import { describe, expect, test } from "bun:test";
import {
  AXIOM_VEIL_BLENDED_CLOSURE_FIXTURE,
  AXIOM_VEIL_COMPARABLE_ROUND,
  AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE,
  AXIOM_VEIL_ROUND_6_ORIGINAL,
  AXIOM_VEIL_ROUND_6_RESCORE,
  AXIOM_VEIL_ROUND_7_COMPOSITE,
  AXIOM_VEIL_ROUND_7_VISUAL,
  AXIOM_VEIL_SUPPRESSED_EVIDENCE_FIXTURE,
  AXIOM_VEIL_UNRELATED_HISTORY_FIXTURE,
  AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE,
  computeScoreScopeDigest,
  evaluateScoreReport,
  GAME_SCORE_CONTRACT_VERSION,
  GameScoreContractViolation,
  scoresComparable,
  validateScoreScope,
  type ScoreReportInput,
  type ScoreRecord,
  type ScoreScope,
} from "./game-score-lineage";

const VISUAL_LENS = "first-party-visual-parity";
const COMPOSITE_LENS = "vertical-slice-composite";

function codes(report: ReturnType<typeof evaluateScoreReport>): string[] {
  return [...new Set(report.violations.map((violation) => violation.code))].sort();
}

function withScope(record: ScoreRecord, overrides: Partial<ScoreScope>): ScoreRecord {
  return { ...record, scope: { ...record.scope, ...overrides } };
}

describe("score scope namespacing", () => {
  test("the digest covers every namespacing facet", () => {
    const base = AXIOM_VEIL_ROUND_7_VISUAL.scope;
    const mutations: Partial<ScoreScope>[] = [
      { lensId: "other-lens" },
      { lensKind: "composite" },
      { rubricVersion: "visual-parity-4" },
      { criticLineage: { ...base.criticLineage, criticVersion: "3.2.0" } },
      { evidenceManifestDigest: "sha256:other-evidence" },
      { scale: { min: 0, max: 10 } },
      { weights: { ...base.weights, lighting: 0.4 } },
      { threshold: 0.8 },
      { capturePopulation: { ...base.capturePopulation, sampleCount: 12 } },
    ];
    for (const mutation of mutations) {
      const mutated = { ...base, ...mutation } as ScoreScope;
      expect(computeScoreScopeDigest(mutated)).not.toBe(computeScoreScopeDigest(base));
      expect(scoresComparable(mutated, base)).toBe(false);
    }
    expect(scoresComparable({ ...base }, base)).toBe(true);
  });

  test("weight ordering does not change the digest", () => {
    const base = AXIOM_VEIL_ROUND_7_VISUAL.scope;
    const reordered: ScoreScope = {
      ...base,
      weights: { "signal-separation": 0.25, depth: 0.25, contact: 0.25, lighting: 0.25 },
    };
    expect(computeScoreScopeDigest(reordered)).toBe(computeScoreScopeDigest(base));
  });

  test("malformed scopes fail closed", () => {
    const base = AXIOM_VEIL_ROUND_7_VISUAL.scope;
    expect(validateScoreScope({ ...base, lensKind: "blended" as never }, "s").map((v) => v.code)).toContain(
      "unknown-lens-kind",
    );
    expect(validateScoreScope({ ...base, scale: { min: 1, max: 1 } }, "s").map((v) => v.code)).toContain("invalid-scale");
    expect(validateScoreScope({ ...base, weights: {} }, "s").map((v) => v.code)).toContain("invalid-weights");
    expect(validateScoreScope({ ...base, threshold: 4 }, "s").map((v) => v.code)).toContain("invalid-threshold");
    expect(
      validateScoreScope({ ...base, capturePopulation: { ...base.capturePopulation, sampleCount: 0 } }, "s").map(
        (v) => v.code,
      ),
    ).toContain("invalid-capture-population");
    expect(
      validateScoreScope(
        { ...base, capturePopulation: { ...base.capturePopulation, captureMode: "screenshot" as never } },
        "s",
      ).map((v) => v.code),
    ).toContain("unknown-capture-mode");
    expect(validateScoreScope({ ...base, contractVersion: 2 as never }, "s").map((v) => v.code)).toContain(
      "unknown-version",
    );
  });

  test("an unknown contract version throws before any score is read", () => {
    expect(() => evaluateScoreReport({ ...AXIOM_VEIL_COMPARABLE_ROUND, contractVersion: 2 })).toThrow(
      GameScoreContractViolation,
    );
  });
});

describe("comparable deltas", () => {
  test("the round-6 rescore supports the round-7 visual delta", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_COMPARABLE_ROUND);
    expect(report.valid).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.reportableDeltas).toHaveLength(1);
    const delta = report.reportableDeltas[0]!;
    expect(delta.basis).toBe("rescored-baseline");
    expect(delta.baselineValue).toBe(0.661);
    expect(delta.candidateValue).toBe(0.676);
    expect(delta.delta).toBeCloseTo(0.015, 10);
    expect(delta.lineageChanges).toEqual(
      expect.arrayContaining(["rubricVersion", "criticLineage", "evidenceManifestDigest", "capturePopulation"]),
    );
  });

  test("an unchanged lineage reports a same-lineage delta without a rescore", () => {
    const priorRound: ScoreRecord = {
      ...AXIOM_VEIL_ROUND_6_RESCORE,
      roundId: "round-6",
    };
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      deltas: [{ lensId: VISUAL_LENS, baseline: priorRound, candidate: AXIOM_VEIL_ROUND_7_VISUAL }],
    });
    expect(report.valid).toBe(true);
    expect(report.reportableDeltas[0]?.basis).toBe("same-lineage");
    expect(report.reportableDeltas[0]?.delta).toBeCloseTo(0.015, 10);
  });

  test("scoresSuppressed blocks every delta when upstream evidence is invalid", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_SUPPRESSED_EVIDENCE_FIXTURE);
    expect(report.valid).toBe(false);
    expect(report.scoresSuppressed).toBe(true);
    expect(report.promotionBlocked).toBe(true);
    expect(report.terminalState).toBe("INVALID_EVIDENCE");
    expect(report.reportableDeltas).toEqual([]);
    expect(codes(report)).toContain("scores-suppressed");
    expect(report.closure.verdict).toBe("evidence-invalid");
  });
});

describe("rejected deltas", () => {
  test("composite-to-visual substitution is rejected", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("composite-to-visual-substitution");
    expect(report.reportableDeltas).toEqual([]);
    expect(report.rejectedDeltas).toHaveLength(1);
    expect(report.terminalState).toBe("INVALID_EVIDENCE");
  });

  test("a changed lineage without a frozen-baseline rescore is rejected", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE);
    expect(report.valid).toBe(false);
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        "missing-baseline-rescore",
        "rubric-version-mismatch",
        "critic-lineage-mismatch",
        "evidence-manifest-mismatch",
        "capture-population-mismatch",
      ]),
    );
    expect(report.rejectedDeltas[0]?.lineageChanges).toContain("rubricVersion");
  });

  test("an unrelated historical baseline is rejected", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_UNRELATED_HISTORY_FIXTURE);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("unrelated-baseline-round");
  });

  test("a rescore of the wrong candidate is rejected", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      deltas: [
        {
          lensId: VISUAL_LENS,
          baseline: AXIOM_VEIL_ROUND_6_ORIGINAL,
          candidate: AXIOM_VEIL_ROUND_7_VISUAL,
          rescoredBaseline: { ...AXIOM_VEIL_ROUND_6_RESCORE, candidateDigest: "sha256:axiom-veil-round-5" },
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("rescore-candidate-mismatch");
  });

  test("a rescore produced under a different lineage is rejected", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      deltas: [
        {
          lensId: VISUAL_LENS,
          baseline: AXIOM_VEIL_ROUND_6_ORIGINAL,
          candidate: AXIOM_VEIL_ROUND_7_VISUAL,
          rescoredBaseline: withScope(AXIOM_VEIL_ROUND_6_RESCORE, { rubricVersion: "visual-parity-5" }),
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("rescore-scope-mismatch");
  });

  test("a delta for a lens the round did not score is rejected", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      deltas: [
        {
          lensId: "audio-mix",
          baseline: AXIOM_VEIL_ROUND_6_RESCORE,
          candidate: AXIOM_VEIL_ROUND_7_VISUAL,
        },
      ],
    });
    expect(codes(report)).toContain("unknown-delta-lens");
  });

  test("a candidate score attributed to another build is rejected", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      scores: [{ ...AXIOM_VEIL_ROUND_7_VISUAL, candidateDigest: "sha256:other" }, AXIOM_VEIL_ROUND_7_COMPOSITE],
    });
    expect(codes(report)).toContain("candidate-identity-mismatch");
    expect(codes(report)).toContain("missing-required-lens");
  });

  test("duplicate lens records and duplicate deltas are rejected", () => {
    const duplicated = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      scores: [AXIOM_VEIL_ROUND_7_VISUAL, AXIOM_VEIL_ROUND_7_VISUAL, AXIOM_VEIL_ROUND_7_COMPOSITE],
      deltas: [
        ...AXIOM_VEIL_COMPARABLE_ROUND.deltas,
        { lensId: VISUAL_LENS, baseline: AXIOM_VEIL_ROUND_6_RESCORE, candidate: AXIOM_VEIL_ROUND_7_VISUAL },
      ],
    });
    expect(codes(duplicated)).toEqual(expect.arrayContaining(["duplicate-lens-record", "duplicate-delta-lens"]));
  });

  test("a value outside the declared scale is rejected", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      scores: [{ ...AXIOM_VEIL_ROUND_7_VISUAL, value: 1.4 }, AXIOM_VEIL_ROUND_7_COMPOSITE],
    });
    expect(codes(report)).toContain("value-out-of-scale");
  });
});

describe("hard-lane closure", () => {
  test("a composite score cannot satisfy a hard lens requirement", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      requiredHardLenses: [COMPOSITE_LENS],
      deltas: [],
    });
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("required-lens-not-hard");
  });

  test("closure language is generated from lane status, not the blended score", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_COMPARABLE_ROUND);
    expect(report.closure.derivedFrom).toBe("hard-lane-status");
    expect(report.closure.verdict).toBe("hard-lane-failure");
    expect(report.closure.statement).toBe(
      "composite vertical-slice-composite passed (0.860 vs 0.850);" +
        " independent first-party-visual-parity not established (0.676 vs 0.850)",
    );
    expect(report.promotionBlocked).toBe(true);
  });

  test("a reporter-supplied closure narrative is rejected", () => {
    const report = evaluateScoreReport(AXIOM_VEIL_BLENDED_CLOSURE_FIXTURE);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("closure-narrative-override");
    expect(report.closure.statement).not.toContain("parity achieved");
    expect(report.closure.verdict).toBe("hard-lane-failure");
  });

  test("hard lanes at or above threshold close cleanly", () => {
    const passing: ScoreReportInput = {
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      scores: [{ ...AXIOM_VEIL_ROUND_7_VISUAL, value: 0.85 }, AXIOM_VEIL_ROUND_7_COMPOSITE],
      deltas: [],
    };
    const report = evaluateScoreReport(passing);
    expect(report.valid).toBe(true);
    expect(report.closure.verdict).toBe("hard-lanes-pass");
    expect(report.promotionBlocked).toBe(false);
    expect(report.contractVersion).toBe(GAME_SCORE_CONTRACT_VERSION);
  });

  test("a missing required hard lens blocks promotion", () => {
    const report = evaluateScoreReport({
      ...AXIOM_VEIL_COMPARABLE_ROUND,
      scores: [AXIOM_VEIL_ROUND_7_COMPOSITE],
      deltas: [],
    });
    expect(report.valid).toBe(false);
    expect(report.promotionBlocked).toBe(true);
    expect(codes(report)).toContain("missing-required-lens");
    expect(report.closure.verdict).toBe("evidence-invalid");
  });
});
