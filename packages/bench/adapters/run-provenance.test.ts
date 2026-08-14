import { describe, expect, test } from "bun:test";
import {
  ADAPTER_VERSION,
  PRICING_SNAPSHOT,
  UsageAccumulator,
  assertNoSecretLikeFlags,
  buildV2ResultArtifact,
  canonicalJson,
  collectGitProvenance,
  computeConfigFingerprint,
  computeDatasetHash,
  computeParity,
  computeQuestionSetHash,
  estimateCost,
  scrubRemoteUrl,
  sumQuestionUsage,
  type BuildArtifactInput,
} from "./run-provenance";
import {
  normalizeResultArtifact,
  present,
  unavailable,
  type UsageV2,
} from "../contracts/result-contract";

// ─── Shared fixtures ─────────────────────────────────────────────────

const FIXTURE_DATASET = JSON.stringify({
  metadata: { name: "fixture", version: "1.0" },
  questions: {
    "procedural-recall": [
      { id: "pr-01", question: "Q1?", answer: "A1", type: "step-recall" },
      { id: "pr-02", question: "Q2?", answer: "A2", type: "precise-count" },
    ],
  },
});

const QUESTION_IDS = [
  { category: "procedural-recall", id: "pr-01", type: "step-recall", question: "Q1?", answer: "A1" },
  { category: "procedural-recall", id: "pr-02", type: "precise-count", question: "Q2?", answer: "A2" },
];

const NON_SECRET_FLAGS = {
  benchmark: "ZouroBench",
  adapter_version: ADAPTER_VERSION,
  dataset: "data/zourobench/seed.json",
  categories: ["procedural-recall"],
  limit: 50,
  judge: true,
  judge_model: "gpt-4o",
  judge_confidence_threshold: 0.7,
  consensus_gate: false,
  profile_valve_shadow: false,
  runs: 1,
  replicate_seeds: ["1"],
  minimum_n: 5,
  answer_model: "gpt-4o-mini",
  embedding_model: "text-embedding-3-small",
  truncation_guard: true,
  generation_timeout_ms: 0,
  max_answer_tokens: 512,
  max_context_chunks: 10,
};

function legacyResult(): Record<string, unknown> {
  return {
    benchmark: "ZouroBench",
    timestamp: "2026-07-24T18:00:00.000Z",
    dataset: "data/zourobench/seed.json",
    total_questions: 2,
    answered: 2,
    scores: {
      overall_accuracy: 50,
      by_category: { "procedural-recall": { correct: 1, total: 2, accuracy: 50 } },
      by_type: {
        "procedural-recall:step-recall": { correct: 1, total: 1, accuracy: 100 },
        "procedural-recall:precise-count": { correct: 0, total: 1, accuracy: 0 },
      },
    },
    latency: { avg_retrieval_ms: 10, avg_answer_ms: 900, p95_retrieval_ms: 20 },
    consensus_gate: { enabled: false },
    profile_valve_shadow: { enabled: false },
    replicate: { index: 1, seed: "1", cohort_id: "cohort-t", minimum_n: 5, timeout_ms: 0 },
    questions: [
      {
        question_id: "pr-01",
        question_type: "step-recall",
        category: "procedural-recall",
        question: "Q1?",
        ground_truth: "A1",
        hypothesis: "A1 indeed",
        retrieved_context: ["ctx"],
        retrieval_ms: 10,
        answer_ms: 900,
        correct: true,
        judge_label: "correct",
        judge_confidence: 0.95,
        finish_reason: "stop",
        usage: present<UsageV2>({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
      },
      {
        question_id: "pr-02",
        question_type: "precise-count",
        category: "procedural-recall",
        question: "Q2?",
        ground_truth: "A2",
        hypothesis: "wrong",
        retrieved_context: [],
        retrieval_ms: 10,
        answer_ms: 900,
        correct: false,
        judge_label: "incorrect",
        judge_confidence: 0.9,
        usage: unavailable<UsageV2>("provider responses for this question did not include token usage"),
      },
    ],
  };
}

function buildInput(overrides: Partial<BuildArtifactInput> = {}): BuildArtifactInput {
  return {
    legacyResult: legacyResult(),
    runId: "run-test-0001",
    benchmark: "ZouroBench",
    timestamp: "2026-07-24T18:00:00.000Z",
    dataset: "data/zourobench/seed.json",
    totalQuestions: 2,
    answered: 2,
    cohort: {
      cohort_id: "cohort-t",
      replicate_index: 1,
      replicate_seed: 1,
      replicate_seed_label: "1",
      minimum_n: 5,
      timeout_ms: null,
    },
    git: {
      git_commit: "a".repeat(40),
      git_dirty: false,
      repository_remote: "https://github.com/example/repo.git",
      branch: "main",
      status: "observed",
    },
    host: "test-host",
    invocation: "bun adapters/zourobench-adapter.ts --dataset data/zourobench/seed.json",
    datasetHash: computeDatasetHash(FIXTURE_DATASET),
    questionSetHash: computeQuestionSetHash(QUESTION_IDS),
    configFingerprint: computeConfigFingerprint(NON_SECRET_FLAGS),
    flags: { ...NON_SECRET_FLAGS },
    execution: {
      answer_model: "gpt-4o-mini",
      judge_model: present("gpt-4o"),
      embedding_model: present("text-embedding-3-small"),
      truncation_guard_enabled: true,
      generation_timeout_ms: present(0),
      max_tokens: 512,
    },
    usage: present<UsageV2>({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    usageCoverage: { observed_calls: 2, unobserved_calls: 1 },
    pricing: present({
      currency: "USD",
      input_cost: 0.000015,
      output_cost: 0.000012,
      total_cost: 0.000027,
      source: PRICING_SNAPSHOT.source,
    }),
    consensus: {
      enabled: false,
      threshold: unavailable<number>("consensus gate was disabled for this run"),
      invocations: unavailable<number>("consensus gate was disabled for this run"),
      splits: unavailable<number>("consensus gate was disabled for this run"),
    },
    parity: unavailable("no parity baseline referenced for this run (pass --parity-baseline)"),
    errors: [],
    recordedAt: "2026-07-24T18:00:05.000Z",
    ...overrides,
  };
}

// ─── Determinism (AC: identical fixture runs → identical hashes) ─────

describe("deterministic hashes", () => {
  test("two identical fixture runs produce the same dataset/question/config hashes", () => {
    expect(computeDatasetHash(FIXTURE_DATASET)).toBe(computeDatasetHash(JSON.stringify(JSON.parse(FIXTURE_DATASET))));
    expect(computeQuestionSetHash(QUESTION_IDS)).toBe(computeQuestionSetHash(QUESTION_IDS.map((q) => ({ ...q }))));
    expect(computeConfigFingerprint(NON_SECRET_FLAGS)).toBe(computeConfigFingerprint({ ...NON_SECRET_FLAGS }));
  });

  test("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, null] } })).toBe(canonicalJson({ a: { c: [3, null], d: 2 }, b: 1 }));
  });

  test("changing configuration changes the fingerprint; changing a question changes the set hash", () => {
    expect(computeConfigFingerprint({ ...NON_SECRET_FLAGS, limit: 10 })).not.toBe(computeConfigFingerprint(NON_SECRET_FLAGS));
    const altered = [{ ...QUESTION_IDS[0]!, answer: "changed" }, QUESTION_IDS[1]!];
    expect(computeQuestionSetHash(altered)).not.toBe(computeQuestionSetHash(QUESTION_IDS));
    expect(computeDatasetHash(FIXTURE_DATASET + " ")).not.toBe(computeDatasetHash(FIXTURE_DATASET));
  });
});

// ─── Secret hygiene (AC: secrets absent from artifacts) ──────────────

describe("secret hygiene", () => {
  test("secret-like flag keys fail closed", () => {
    for (const key of ["api_key", "zoToken", "client_secret", "db_password", "authorization", "bearer_header", "aws_credentials"]) {
      expect(() => assertNoSecretLikeFlags({ [key]: "x" })).toThrow(/looks like a credential/);
      expect(() => buildV2ResultArtifact(buildInput({ flags: { [key]: "x" } }))).toThrow(/looks like a credential/);
    }
    expect(() => assertNoSecretLikeFlags(NON_SECRET_FLAGS)).not.toThrow();
    // Token COUNTS are configuration, not credentials.
    expect(() => assertNoSecretLikeFlags({ max_answer_tokens: 512 })).not.toThrow();
  });

  test("remote URLs are scrubbed of userinfo", () => {
    expect(scrubRemoteUrl("https://user:hunter2@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(scrubRemoteUrl("https://x-access-token:ghp_abc@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(scrubRemoteUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(scrubRemoteUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  test("serialized artifact contains no sentinel secret values from the environment", () => {
    const sentinelKey = "sk-sentinel-api-key-do-not-leak";
    const sentinelToken = "zo-sentinel-token-do-not-leak";
    process.env.OPENAI_API_KEY_SENTINEL_TEST = sentinelKey;
    process.env.ZO_TOKEN_SENTINEL_TEST = sentinelToken;
    try {
      const serialized = JSON.stringify(buildV2ResultArtifact(buildInput()));
      expect(serialized).not.toContain(sentinelKey);
      expect(serialized).not.toContain(sentinelToken);
      expect(serialized.toLowerCase()).not.toContain('"authorization"');
    } finally {
      delete process.env.OPENAI_API_KEY_SENTINEL_TEST;
      delete process.env.ZO_TOKEN_SENTINEL_TEST;
    }
  });

  test("git provenance failure records honest unavailable literals", () => {
    const failed = collectGitProvenance(() => null);
    expect(failed).toEqual({
      git_commit: "unavailable",
      git_dirty: null,
      repository_remote: null,
      branch: null,
      status: "unavailable",
    });
  });

  test("git provenance scrubs credentials and reports dirty state", () => {
    const byArgs = (args: string[]): string | null => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return "b".repeat(40);
      if (key === "status --porcelain") return " M some/file.ts";
      if (key === "config --get remote.origin.url") return "https://user:hunter2@github.com/o/r.git";
      if (key === "rev-parse --abbrev-ref HEAD") return "feature/x";
      return null;
    };
    expect(collectGitProvenance(byArgs)).toEqual({
      git_commit: "b".repeat(40),
      git_dirty: true,
      repository_remote: "https://github.com/o/r.git",
      branch: "feature/x",
      status: "observed",
    });
  });
});

// ─── Contract round-trip + legacy compatibility ──────────────────────

describe("artifact assembly", () => {
  test("built artifact normalizes as a valid v2 run with scores unchanged", () => {
    const artifact = buildV2ResultArtifact(buildInput());
    const normalized = normalizeResultArtifact(JSON.parse(JSON.stringify(artifact)));
    if (!normalized.ok) throw new Error(`expected ok, got: ${JSON.stringify(normalized.errors)}`);
    expect(normalized.run.schema_version).toBe(2);
    expect(normalized.run.run_id).toEqual(present("run-test-0001"));
    expect(normalized.run.scores).toEqual(legacyResult().scores as never);
    expect(normalized.run.latency).toEqual(legacyResult().latency as never);
    expect(normalized.run.totals).toEqual({ total_questions: 2, answered: 2 });
    expect(normalized.run.questions).toHaveLength(2);
    expect(normalized.run.questions[0]!.usage).toEqual(
      present({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    );
    expect(normalized.run.parity.value).toBeNull();
  });

  test("legacy top-level fields are byte-identical to the v1 producer output", () => {
    const legacy = legacyResult();
    const artifact = buildV2ResultArtifact(buildInput());
    for (const key of Object.keys(legacy)) {
      expect(JSON.stringify(artifact[key])).toBe(JSON.stringify(legacy[key]));
    }
  });

  test("legacy readers' required fields survive (report.ts / regression-gate.ts contract)", () => {
    const artifact = buildV2ResultArtifact(buildInput()) as Record<string, any>;
    // report.ts:79 guard — `if (!data.benchmark || !data.scores || !data.latency) continue;`
    expect(artifact.benchmark).toBe("ZouroBench");
    expect(typeof artifact.timestamp).toBe("string");
    expect(artifact.total_questions).toBe(2);
    // regression-gate.ts reads scores.overall_accuracy and by_category accuracies.
    expect(artifact.scores.overall_accuracy).toBe(50);
    expect(artifact.scores.by_category["procedural-recall"].accuracy).toBe(50);
    expect(artifact.latency.avg_retrieval_ms).toBe(10);
    expect(artifact.replicate.cohort_id).toBe("cohort-t");
  });

  test("a legacy v1 artifact (without the new blocks) still normalizes as v1", () => {
    const normalized = normalizeResultArtifact(legacyResultAsV1());
    if (!normalized.ok) throw new Error(`expected ok, got: ${JSON.stringify(normalized.errors)}`);
    expect(normalized.run.schema_version).toBe(1);
    expect(normalized.run.provenance.value).toBeNull();
  });
});

/** Legacy artifact with a v1-shaped replicate block (numeric seed) and plain questions. */
function legacyResultAsV1(): Record<string, unknown> {
  const legacy = legacyResult();
  const questions = (legacy.questions as Array<Record<string, unknown>>).map((q) => {
    const { usage: _usage, finish_reason: _finish, ...rest } = q;
    return rest;
  });
  return { ...legacy, questions, replicate: { index: 1, seed: 1, cohort_id: "cohort-t", minimum_n: 5, timeout_ms: 0 } };
}

// ─── Usage + pricing ─────────────────────────────────────────────────

describe("usage accumulation and pricing", () => {
  const usage = (p: number, c: number): UsageV2 => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

  test("accumulates per-model sums and honest coverage counters", () => {
    const acc = new UsageAccumulator();
    acc.add("gpt-4o-mini", usage(1000, 200));
    acc.add("gpt-4o-mini", usage(500, 100));
    acc.add("gpt-4o", usage(300, 30));
    acc.add("byok:some-model", undefined);
    expect(acc.coverage()).toEqual({ observed_calls: 3, unobserved_calls: 1 });
    expect(acc.evidencedTotals()).toEqual(present(usage(1800, 330)));
    expect(acc.usageByModel()["gpt-4o-mini"]).toEqual(usage(1500, 300));
  });

  test("zero observed calls stays unavailable, never zero", () => {
    const acc = new UsageAccumulator();
    acc.add("byok:some-model", undefined);
    expect(acc.evidencedTotals().value).toBeNull();
    expect(acc.evidencedTotals().availability_reason).toContain("no provider call");
    expect(acc.evidencedPricing().value).toBeNull();
  });

  test("cost estimate follows the static snapshot arithmetic", () => {
    const { pricing, error } = estimateCost({
      "gpt-4o-mini": usage(1_000_000, 1_000_000),
      "gpt-4o": usage(2_000_000, 100_000),
    });
    expect(error).toBeNull();
    expect(pricing!.currency).toBe("USD");
    expect(pricing!.by_model["gpt-4o-mini"]).toEqual({ input_cost: 0.15, output_cost: 0.6, total_cost: 0.75 });
    expect(pricing!.by_model["gpt-4o"]).toEqual({ input_cost: 5, output_cost: 1, total_cost: 6 });
    expect(pricing!.input_cost).toBe(5.15);
    expect(pricing!.output_cost).toBe(1.6);
    expect(pricing!.total_cost).toBe(6.75);
    expect(pricing!.source).toContain("estimated");
  });

  test("prices direct and OpenRouter Kimi K3 usage from the frozen snapshot", () => {
    const { pricing, error } = estimateCost({
      "kimi:kimi-k3": usage(1_000_000, 1_000_000),
      "or:moonshotai/kimi-k3": usage(1_000_000, 1_000_000),
    });
    expect(error).toBeNull();
    expect(PRICING_SNAPSHOT.as_of).toBe("2026-07-31");
    expect(pricing!.by_model["kimi:kimi-k3"]).toEqual({
      input_cost: 3,
      output_cost: 15,
      total_cost: 18,
    });
    expect(pricing!.by_model["or:moonshotai/kimi-k3"]).toEqual({
      input_cost: 3,
      output_cost: 15,
      total_cost: 18,
    });
    expect(pricing!.total_cost).toBe(36);
  });

  test("prices the approved OpenRouter frontier cohort set from the frozen snapshot", () => {
    const { pricing, error } = estimateCost({
      "or:x-ai/grok-4.5": usage(1_000_000, 1_000_000),
      "or:z-ai/glm-5.2": usage(1_000_000, 1_000_000),
      "or:qwen/qwen3.6-27b": usage(1_000_000, 1_000_000),
      "or:nvidia/nemotron-3-super-120b-a12b": usage(1_000_000, 1_000_000),
    });
    expect(error).toBeNull();
    expect(pricing!.by_model["or:x-ai/grok-4.5"].total_cost).toBe(8);
    expect(pricing!.by_model["or:z-ai/glm-5.2"].total_cost).toBe(4.64);
    expect(pricing!.by_model["or:qwen/qwen3.6-27b"].total_cost).toBe(2.3);
    expect(pricing!.by_model["or:nvidia/nemotron-3-super-120b-a12b"].total_cost).toBe(0.485);
    expect(pricing!.total_cost).toBe(15.425);
  });

  test("unknown model makes pricing unavailable rather than partially costed", () => {
    const { pricing, error } = estimateCost({ "byok:mystery": usage(10, 10) });
    expect(pricing).toBeNull();
    expect(error).toContain("byok:mystery");
  });

  test("per-question usage sums observed parts and stays undefined when none observed", () => {
    expect(sumQuestionUsage([usage(10, 2), usage(5, 1)])).toEqual(usage(15, 3));
    expect(sumQuestionUsage([usage(10, 2), undefined])).toEqual(usage(10, 2));
    expect(sumQuestionUsage([undefined, undefined])).toBeUndefined();
  });
});

// ─── Parity reference ────────────────────────────────────────────────

describe("parity", () => {
  test("v1 baseline pairs by question_id and reports the accuracy delta", () => {
    const parity = computeParity(75, ["pr-01", "pr-02", "pr-99"], legacyResultAsV1(), "baseline.json");
    expect(parity.value).toEqual({
      baseline_run_id: "ZouroBench@2026-07-24T18:00:00.000Z",
      baseline_overall_accuracy: 50,
      delta_overall_accuracy: 25,
      paired_questions: 2,
    });
  });

  test("v2 baseline uses its recorded run_id", () => {
    const baseline = buildV2ResultArtifact(buildInput());
    const parity = computeParity(40, ["pr-01"], JSON.parse(JSON.stringify(baseline)), "baseline-v2.json");
    expect(parity.value?.baseline_run_id).toBe("run-test-0001");
    expect(parity.value?.delta_overall_accuracy).toBe(-10);
    expect(parity.value?.paired_questions).toBe(1);
  });

  test("invalid baseline records an honest unavailable reason", () => {
    const parity = computeParity(40, ["pr-01"], { not: "an artifact" }, "junk.json");
    expect(parity.value).toBeNull();
    expect(parity.availability_reason).toContain("junk.json");
  });
});
