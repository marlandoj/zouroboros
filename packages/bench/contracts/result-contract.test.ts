import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  aggregateArtifacts,
  detectArtifactVersion,
  normalizeResultArtifact,
  UNAVAILABLE_REASONS,
  type NormalizedRun,
} from "./result-contract";

const FIXTURES = join(import.meta.dir, "fixtures");
const JULY_3_ARTIFACT = join(
  import.meta.dir,
  "..",
  "data",
  "runs",
  "ZouroBench-2026-07-03T13-07-02-577Z.json",
);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadFixture(name: string): unknown {
  return loadJson(join(FIXTURES, name));
}

function normalizeOk(raw: unknown): NormalizedRun {
  const result = normalizeResultArtifact(raw);
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  return result.run;
}

// ─── Version detection ───────────────────────────────────────────────

describe("detectArtifactVersion", () => {
  test("July 3 artifact detects as legacy v1", () => {
    expect(detectArtifactVersion(loadJson(JULY_3_ARTIFACT))).toEqual({ version: 1, issue: null });
  });

  test("schema_version: 2 detects as v2", () => {
    expect(detectArtifactVersion(loadFixture("v2-complete.json"))).toEqual({ version: 2, issue: null });
  });

  test("foreign schema is rejected, not guessed", () => {
    const detected = detectArtifactVersion(loadFixture("foreign-schema.json"));
    expect(detected.version).toBeNull();
    expect(detected.issue?.code).toBe("foreign_schema");
  });

  test("unknown schema_version is rejected", () => {
    const detected = detectArtifactVersion({ schema_version: 3 });
    expect(detected.version).toBeNull();
    expect(detected.issue?.code).toBe("unsupported_version");
  });

  test("non-object artifacts are rejected", () => {
    for (const raw of [null, 42, "run", [1, 2]]) {
      const detected = detectArtifactVersion(raw);
      expect(detected.version).toBeNull();
      expect(detected.issue?.code).toBe("not_object");
    }
  });
});

// ─── Legacy v1: July 3 artifact ──────────────────────────────────────

describe("legacy v1 normalization (July 3 artifact)", () => {
  const run = normalizeOk(loadJson(JULY_3_ARTIFACT));

  test("produces the existing totals", () => {
    expect(run.schema_version).toBe(1);
    expect(run.benchmark).toBe("ZouroBench");
    expect(run.timestamp).toBe("2026-07-03T13:07:02.577Z");
    expect(run.totals).toEqual({ total_questions: 54, answered: 54 });
    expect(run.questions).toHaveLength(54);
  });

  test("produces the existing scores", () => {
    expect(run.scores.overall_accuracy).toBe(98.1);
    expect(run.scores.by_category["procedural-recall"]).toEqual({ correct: 17, total: 18, accuracy: 94.4 });
    expect(run.scores.by_category["cross-persona-transfer"]).toEqual({ correct: 18, total: 18, accuracy: 100 });
    expect(run.scores.by_category["swarm-context-propagation"]).toEqual({ correct: 18, total: 18, accuracy: 100 });
    const correctCount = run.questions.filter((q) => q.correct).length;
    expect(correctCount).toBe(53);
  });

  test("produces the existing latency block", () => {
    expect(run.latency).toEqual({ avg_retrieval_ms: 269, avg_answer_ms: 2878, p95_retrieval_ms: 365 });
  });

  test("consensus gate is preserved as disabled with unavailable evidence", () => {
    expect(run.consensus.enabled).toBe(false);
    expect(run.consensus.threshold.value).toBeNull();
    expect(run.consensus.threshold.availability_reason).toBe(UNAVAILABLE_REASONS.gateDisabled);
  });

  test("unrecorded run metadata stays unknown — never zero/false/pass", () => {
    for (const field of [run.run_id, run.provenance, run.execution, run.usage, run.pricing, run.parity, run.cohort] as const) {
      expect(field.value).toBeNull();
      expect(typeof field.availability_reason).toBe("string");
      expect(field.availability_reason!.length).toBeGreaterThan(0);
    }
    expect(run.usage.value).not.toBe(0);
    expect(run.parity.value).not.toBe("pass");
    expect(run.provenance.availability_reason).toBe(UNAVAILABLE_REASONS.v1NoProvenance);
    expect(run.cohort.availability_reason).toBe(UNAVAILABLE_REASONS.v1NoCohort);
  });

  test("absent per-question truncation/timeout flags stay ambiguous, not false", () => {
    const q = run.questions[0];
    expect(q.truncated.value).toBeNull();
    expect(q.truncated.availability_reason).toContain("ambiguous");
    expect(q.timed_out.value).toBeNull();
    expect(q.judge_label.value).toBe("correct");
    expect(typeof q.judge_confidence.value).toBe("number");
  });
});

// ─── Legacy v1: consensus-enabled / timed-out / truncated fixture ────

describe("v1 consensus-enabled fixture", () => {
  const run = normalizeOk(loadFixture("v1-consensus-enabled.json"));

  test("run-level gate evidence is preserved", () => {
    expect(run.consensus.enabled).toBe(true);
    expect(run.consensus.threshold.value).toBe(0.7);
    expect(run.consensus.invocations.value).toBe(2);
    expect(run.consensus.splits.value).toBe(1);
  });

  test("late-v1 replicate block maps to cohort evidence", () => {
    expect(run.cohort.value).toEqual({
      cohort_id: "cohort-2026-06-21",
      replicate_index: 1,
      replicate_seed: 1084216302,
      minimum_n: 3,
      timeout_ms: 0,
    });
  });

  test("per-question consensus evidence is preserved verbatim", () => {
    const [q1, q2, q3] = run.questions;
    expect(q1.consensus_invoked.value).toBe(true);
    expect(q1.consensus_verdict.value).toBe("passed");
    expect(q2.consensus_verdict.value).toBe("split");
    expect(q2.consensus_confidence.value).toBe(0.55);
    // q3 has no consensus fields — gate enabled, so evidence is absent, not "pass"
    expect(q3.consensus_verdict.value).toBeNull();
    expect(q3.consensus_verdict.availability_reason).toBe(UNAVAILABLE_REASONS.gateEvidenceAbsent);
  });

  test("explicit timed_out / truncated flags are preserved; absent stays unknown", () => {
    const [q1, q2, q3] = run.questions;
    expect(q2.timed_out.value).toBe(true);
    expect(q3.truncated.value).toBe(true);
    expect(q1.timed_out.value).toBeNull();
    expect(q1.truncated.value).toBeNull();
    expect(q2.truncated.value).toBeNull();
  });
});

// ─── v2 normalization ────────────────────────────────────────────────

describe("v2 normalization", () => {
  test("complete v2 fixture validates with every required provenance field", () => {
    const run = normalizeOk(loadFixture("v2-complete.json"));
    expect(run.schema_version).toBe(2);
    expect(run.run_id.value).toBe("zb-2026-07-24-r01");
    expect(run.provenance.value).toEqual({
      produced_by: "zourobench-adapter",
      adapter_version: "2.0.0",
      git_commit: "d5cac30c0000000000000000000000000000abcd",
      host: "zo-workspace",
      invocation:
        "bun adapters/zourobench-adapter.ts --dataset data/zourobench/seed.json --output data/runs/ --judge",
      config_fingerprint: "sha256:3f1b9c0d7e5a",
      recorded_at: "2026-07-24T12:00:03.000Z",
    });
    expect(run.cohort.value?.cohort_id).toBe("cohort-2026-07-24");
    expect(run.execution.value?.answer_model).toBe("gpt-4o-mini");
    expect(run.usage.value?.total_tokens).toBe(20400);
    expect(run.pricing.value?.total_cost).toBe(0.00414);
    expect(run.parity.value?.baseline_run_id).toBe("zb-2026-07-03");
    expect(run.errors).toEqual([
      { question_id: "pr-02", stage: "generation", message: "generation aborted by BENCH_GEN_TIMEOUT_MS deadline" },
    ]);
    const q2 = run.questions[1];
    expect(q2.truncated.value).toBe(true);
    expect(q2.timed_out.value).toBe(true);
    expect(q2.usage.value?.total_tokens).toBe(10100);
  });

  test("optional producer provenance is preserved and type-checked", () => {
    const raw = loadFixture("v2-complete.json") as Record<string, unknown>;
    const provenance = raw.provenance as Record<string, unknown>;
    provenance.git_dirty = true;
    provenance.dataset_sha256 = "sha256:dataset";
    provenance.question_set_sha256 = "sha256:questions";
    const run = normalizeOk(raw);
    expect(run.provenance.value?.git_dirty).toBe(true);
    expect(run.provenance.value?.dataset_sha256).toBe("sha256:dataset");
    expect(run.provenance.value?.question_set_sha256).toBe("sha256:questions");

    provenance.git_dirty = "true";
    const malformed = normalizeResultArtifact(raw);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors).toContainEqual({
        path: "$.provenance.git_dirty",
        code: "wrong_type",
        message: "expected boolean when present",
      });
    }
  });

  test("missing evidence stays null with its recorded reason — never zero/false/pass", () => {
    const run = normalizeOk(loadFixture("v2-missing-evidence.json"));
    expect(run.usage.value).toBeNull();
    expect(run.usage.availability_reason).toBe("provider response omitted usage block for this run");
    expect(run.pricing.value).toBeNull();
    expect(run.pricing.availability_reason).toBe("no published price sheet for pinned model snapshot");
    expect(run.parity.value).toBeNull();
    expect(run.parity.availability_reason).toBe("no baseline run declared for this cohort");
    expect(run.consensus.enabled).toBe(false);
    expect(run.consensus.threshold.value).toBeNull();
    expect(run.execution.value?.judge_model.value).toBeNull();
    expect(run.execution.value?.judge_model.availability_reason).toContain("heuristic judge");
    // provenance itself is still fully required
    expect(run.provenance.value?.git_commit).toBe("d5cac30c0000000000000000000000000000abcd");
  });

  test("v2 with a missing required provenance field is rejected", () => {
    const result = normalizeResultArtifact(loadFixture("v2-bad-provenance.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "$.provenance.git_commit",
        code: "missing_field",
        message: "required string field is missing",
      });
    }
  });

  test("a null Evidenced value without a reason is rejected", () => {
    const raw = loadFixture("v2-missing-evidence.json") as Record<string, unknown>;
    raw.usage = { value: null, availability_reason: null };
    const result = normalizeResultArtifact(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "$.usage.availability_reason" && e.code === "invalid_value")).toBe(true);
    }
  });
});

// ─── Invalid artifacts ───────────────────────────────────────────────

describe("invalid artifacts", () => {
  test("malformed v1 returns structured errors", () => {
    const result = normalizeResultArtifact(loadFixture("malformed.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("$.total_questions");
      expect(paths).toContain("$.scores.overall_accuracy");
      expect(paths).toContain("$.consensus_gate.enabled");
      expect(result.errors.every((e) => typeof e.code === "string" && typeof e.message === "string")).toBe(true);
    }
  });

  test("partial v1 (missing blocks) returns structured errors", () => {
    const result = normalizeResultArtifact(loadFixture("partial-v1.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("$.answered");
      expect(paths).toContain("$.latency");
      expect(paths).toContain("$.consensus_gate");
      expect(paths).toContain("$.scores.by_type");
    }
  });

  test("inconsistent score cells (correct > total) are invalid_value errors", () => {
    const result = normalizeResultArtifact(loadFixture("malformed.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "$.scores.by_category.procedural-recall" && e.code === "invalid_value"),
      ).toBe(true);
    }
  });
});

// ─── Aggregation ─────────────────────────────────────────────────────

describe("aggregateArtifacts", () => {
  test("invalid artifacts are excluded from aggregates with their errors", () => {
    const result = aggregateArtifacts([
      { key: "july-3", raw: loadJson(JULY_3_ARTIFACT) },
      { key: "v2-complete", raw: loadFixture("v2-complete.json") },
      { key: "malformed", raw: loadFixture("malformed.json") },
      { key: "foreign", raw: loadFixture("foreign-schema.json") },
    ]);
    expect(result.included_runs).toBe(2);
    expect(result.excluded.map((e) => e.key)).toEqual(["malformed", "foreign"]);
    expect(result.excluded.every((e) => e.errors.length > 0)).toBe(true);
    // july-3 (53/54) + v2-complete (1/2) — malformed/foreign contribute nothing
    expect(result.total_questions).toBe(56);
    expect(result.answered).toBe(56);
    expect(result.correct).toBe(54);
    expect(result.overall_accuracy).toBe(96.4);
    expect(result.by_category["procedural-recall"]).toEqual({ correct: 18, total: 20, accuracy: 90 });
  });

  test("no valid runs yields null accuracy, not a fabricated zero", () => {
    const result = aggregateArtifacts([{ key: "foreign", raw: loadFixture("foreign-schema.json") }]);
    expect(result.included_runs).toBe(0);
    expect(result.overall_accuracy).toBeNull();
  });
});
