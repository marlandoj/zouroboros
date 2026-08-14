import { test, expect } from "bun:test";
import {
  calibrateTimeoutSweep,
  comparePairedReplicates,
  computeReplicateDistribution,
  deterministicBootstrapMeanCi,
  type ReplicateRunInput,
} from "./replicate-distribution";

// ── P1-5: replicate-distribution 4-tuple (Solid/Average/Best-of/Ceiling) ──

test("empty run set returns zeros with no per-question reliability", () => {
  const d = computeReplicateDistribution([]);
  expect(d.n).toBe(0);
  expect(d.avgAccuracy).toBe(0);
  expect(d.bestOf).toBe(0);
  expect(d.worst).toBe(0);
  expect(d.solidPct).toBeUndefined();
  expect(d.ceilingPct).toBeUndefined();
  expect(d.spread).toBeUndefined();
  expect(d.truncatedCount).toBe(0);
  expect(d.timedOutCount).toBe(0);
  expect(d.perQuestion).toEqual([]);
});

test("N=1 makes Solid equal Ceiling (spread zero)", () => {
  const runs: ReplicateRunInput[] = [
    {
      scores: { overall_accuracy: 50 },
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: false },
      ],
    },
  ];
  const d = computeReplicateDistribution(runs);
  expect(d.n).toBe(1);
  expect(d.avgAccuracy).toBe(50);
  expect(d.bestOf).toBe(50);
  expect(d.worst).toBe(50);
  expect(d.solidPct).toBe(50);
  expect(d.ceilingPct).toBe(50);
  expect(d.spread).toBe(0);
});

test("N=3 flaky question widens the Solid→Ceiling spread", () => {
  const runs: ReplicateRunInput[] = [
    {
      scores: { overall_accuracy: 66.7 },
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: true },
        { question_id: "q3", correct: false },
      ],
    },
    {
      scores: { overall_accuracy: 33.3 },
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: false },
        { question_id: "q3", correct: false },
      ],
    },
    {
      scores: { overall_accuracy: 66.7 },
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: true },
        { question_id: "q3", correct: false },
      ],
    },
  ];
  const d = computeReplicateDistribution(runs);
  expect(d.n).toBe(3);
  // q1 correct in all 3 → solid; q2 correct in 2 → ceiling only; q3 never.
  expect(d.solidPct).toBe(33.3); // 1/3
  expect(d.ceilingPct).toBe(66.7); // 2/3
  expect(d.spread).toBeCloseTo(33.4, 5);
  expect(d.avgAccuracy).toBe(55.6); // (66.7+33.3+66.7)/3
  expect(d.bestOf).toBe(66.7);
  expect(d.worst).toBe(33.3);

  const q2 = d.perQuestion.find((p) => p.question_id === "q2")!;
  expect(q2.correctCount).toBe(2);
  expect(q2.solid).toBe(false);
  expect(q2.ceiling).toBe(true);
});

test("runs with only overall_accuracy yield avg/best/worst but no reliability split", () => {
  const runs: ReplicateRunInput[] = [
    { scores: { overall_accuracy: 80 } },
    { scores: { overall_accuracy: 90 } },
  ];
  const d = computeReplicateDistribution(runs);
  expect(d.avgAccuracy).toBe(85);
  expect(d.bestOf).toBe(90);
  expect(d.worst).toBe(80);
  expect(d.solidPct).toBeUndefined();
  expect(d.ceilingPct).toBeUndefined();
  expect(d.spread).toBeUndefined();
  expect(d.perQuestion).toEqual([]);
});

test("mixed runs (some without question data) suppress reliability split", () => {
  const runs: ReplicateRunInput[] = [
    {
      scores: { overall_accuracy: 100 },
      questions: [{ question_id: "q1", correct: true }],
    },
    { scores: { overall_accuracy: 0 } },
  ];
  const d = computeReplicateDistribution(runs);
  expect(d.avgAccuracy).toBe(50);
  expect(d.solidPct).toBeUndefined();
  expect(d.ceilingPct).toBeUndefined();
});

test("truncated and timed_out flags are tallied across all runs", () => {
  const runs: ReplicateRunInput[] = [
    {
      scores: { overall_accuracy: 50 },
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: false, truncated: true },
      ],
    },
    {
      scores: { overall_accuracy: 50 },
      questions: [
        { question_id: "q1", correct: true, timed_out: true },
        { question_id: "q2", correct: false, truncated: true },
      ],
    },
  ];
  const d = computeReplicateDistribution(runs);
  expect(d.truncatedCount).toBe(2);
  expect(d.timedOutCount).toBe(1);
});

test("overall_accuracy is derived from questions when absent", () => {
  const runs: ReplicateRunInput[] = [
    {
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: true },
        { question_id: "q3", correct: false },
      ],
    },
  ];
  const d = computeReplicateDistribution(runs);
  expect(d.avgAccuracy).toBe(66.7); // 2/3 derived
  expect(d.solidPct).toBe(66.7);
  expect(d.ceilingPct).toBe(66.7);
});

test("a question missing from one run cannot be Solid", () => {
  const runs: ReplicateRunInput[] = [
    {
      scores: { overall_accuracy: 100 },
      questions: [
        { question_id: "q1", correct: true },
        { question_id: "q2", correct: true },
      ],
    },
    {
      scores: { overall_accuracy: 100 },
      questions: [
        { question_id: "q1", correct: true },
        // q2 absent this run
      ],
    },
  ];
  const d = computeReplicateDistribution(runs);
  // q1 solid (both runs); q2 present+correct only once → ceiling, not solid.
  expect(d.solidPct).toBe(50); // 1/2 qids solid
  expect(d.ceilingPct).toBe(100); // both qids correct at least once
  const q2 = d.perQuestion.find((p) => p.question_id === "q2")!;
  expect(q2.correctCount).toBe(1);
  expect(q2.solid).toBe(false);
  expect(q2.ceiling).toBe(true);
});

test("N below five is mechanically underpowered even with paired seeds", () => {
  const runs: ReplicateRunInput[] = [1, 2, 3, 4].map((seed) => ({
    replicate: { seed },
    scores: { overall_accuracy: 75 + seed },
    questions: [{ question_id: "q1", correct: true }],
  }));
  const d = computeReplicateDistribution(runs);
  expect(d.minimumN).toBe(5);
  expect(d.status).toBe("underpowered");
  expect(d.pairing.paired).toBe(true);
  expect(d.statusReasons).toContain("N=4 is below minimum N=5");
});

test("N=5 with unique declared seeds is publishable and carries deterministic CI", () => {
  const runs: ReplicateRunInput[] = [1, 2, 3, 4, 5].map((seed) => ({
    replicate: { seed },
    scores: { overall_accuracy: 70 + seed * 5 },
    questions: [
      { question_id: "q1", correct: true },
      { question_id: "q2", correct: seed >= 3, truncated: seed === 1, timed_out: seed === 2 },
    ],
  }));
  const first = computeReplicateDistribution(runs);
  const second = computeReplicateDistribution(runs);
  expect(first.status).toBe("publishable");
  expect(first.avgAccuracyCi).toEqual(second.avgAccuracyCi);
  expect(first.avgAccuracyCi?.method).toBe("deterministic-bootstrap");
  expect(first.truncatedRate).toBe(0.1);
  expect(first.timedOutRate).toBe(0.1);
});

test("missing or duplicate seeds prevent publication", () => {
  const missing = Array.from({ length: 5 }, () => ({ scores: { overall_accuracy: 90 } }));
  expect(computeReplicateDistribution(missing).status).toBe("underpowered");
  const duplicate = Array.from({ length: 5 }, () => ({
    replicate: { seed: "same" },
    scores: { overall_accuracy: 90 },
  }));
  const d = computeReplicateDistribution(duplicate);
  expect(d.status).toBe("underpowered");
  expect(d.pairing.reason).toContain("unique");
});

test("paired comparison bootstraps deterministic seed-aligned deltas", () => {
  const baseline = ["a", "b", "c", "d", "e"].map((seed, index) => ({
    replicate: { seed },
    scores: { overall_accuracy: 70 + index },
  }));
  const candidate = ["e", "d", "c", "b", "a"].map((seed) => ({
    replicate: { seed },
    scores: { overall_accuracy: 80 + ["a", "b", "c", "d", "e"].indexOf(seed) },
  }));
  const first = comparePairedReplicates(baseline, candidate);
  const second = comparePairedReplicates(baseline, candidate);
  expect(first.paired).toBe(true);
  expect(first.n).toBe(5);
  expect(first.meanDelta).toBe(10);
  expect(first.meanDeltaCi).toEqual(second.meanDeltaCi);
});

test("paired comparison rejects mismatched seed sets", () => {
  const result = comparePairedReplicates(
    [{ replicate: { seed: 1 }, scores: { overall_accuracy: 50 } }],
    [{ replicate: { seed: 2 }, scores: { overall_accuracy: 60 } }],
  );
  expect(result.paired).toBe(false);
  expect(result.meanDelta).toBeNull();
});

test("deterministic bootstrap returns a degenerate interval for a constant sample", () => {
  expect(deterministicBootstrapMeanCi([42, 42, 42])).toEqual({
    lower: 42,
    upper: 42,
    confidence: 0.95,
    method: "deterministic-bootstrap",
    iterations: 2_000,
  });
});

test("timeout calibration chooses the smallest timeout on the post-knee plateau", () => {
  const result = calibrateTimeoutSweep([
    { timeoutMs: 5_000, passed: 60, attempts: 100 },
    { timeoutMs: 10_000, passed: 91, attempts: 100 },
    { timeoutMs: 20_000, passed: 99, attempts: 100 },
    { timeoutMs: 30_000, passed: 100, attempts: 100 },
  ], { plateauTolerance: 0.01 });
  expect(result.status).toBe("calibrated");
  expect(result.kneeTimeoutMs).toBe(20_000);
  expect(result.selectedTimeoutMs).toBe(20_000);
});

test("timeout calibration is insufficient with one timeout level", () => {
  const result = calibrateTimeoutSweep([{ timeoutMs: 5_000, passed: 9, attempts: 10 }]);
  expect(result.status).toBe("insufficient_data");
  expect(result.selectedTimeoutMs).toBeNull();
});

test("timeout calibration does not mistake an early spike for a stable plateau", () => {
  const result = calibrateTimeoutSweep([
    { timeoutMs: 5_000, passed: 99, attempts: 100 },
    { timeoutMs: 10_000, passed: 80, attempts: 100 },
    { timeoutMs: 20_000, passed: 99, attempts: 100 },
    { timeoutMs: 30_000, passed: 100, attempts: 100 },
  ]);
  expect(result.selectedTimeoutMs).toBe(20_000);
});
