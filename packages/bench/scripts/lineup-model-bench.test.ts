import { describe, expect, test } from "bun:test";
import {
  buildLineupBenchmarkPlan,
  buildProviderAwareWaves,
  cohortIdFor,
  LINEUP_BENCHMARK_SEEDS,
  parseExistingReplicateArtifact,
  providerForBenchmarkRoute,
  runProviderAwareWaves,
  type RosterModel,
} from "./lineup-model-bench";

function rosterModel(overrides: Partial<RosterModel> = {}): RosterModel {
  return {
    canonicalModel: "glm-5.2",
    benchmarkRoute: "or:z-ai/glm-5.2",
    roles: ["proposer"],
    profiles: ["flagship"],
    priority: 0,
    benchmarkEligible: true,
    benchmarkRunnable: true,
    benchmarkStatus: "missing",
    ...overrides,
  };
}

describe("lineup model benchmark plan", () => {
  test("resumes the next missing replicate in a stable route-specific cohort", () => {
    const model = rosterModel();
    const cohortId = cohortIdFor(model);
    const plan = buildLineupBenchmarkPlan({
      schemaVersion: 1,
      benchmarkPolicy: { minimumReplicates: LINEUP_BENCHMARK_SEEDS.length },
      models: [model],
    }, [
      { cohortId, model: model.benchmarkRoute, index: 1 },
      { cohortId, model: model.benchmarkRoute, index: 2 },
    ]);
    expect(plan[0]).toMatchObject({
      state: "in-progress",
      completedReplicates: [1, 2],
      nextReplicate: 3,
    });
    expect(cohortIdFor({ ...model, benchmarkRoute: "hf:zai-org/GLM-5.2" })).not.toBe(cohortId);
  });

  test("skips qualified and unsupported-role models", () => {
    const plan = buildLineupBenchmarkPlan({
      schemaVersion: 1,
      benchmarkPolicy: { minimumReplicates: 5 },
      models: [
        rosterModel({ canonicalModel: "kimi-k3", benchmarkStatus: "qualified" }),
        rosterModel({
          canonicalModel: "gpt-5.3-codex",
          benchmarkRoute: "oc:gpt-5.3-codex",
          roles: ["coder"],
          benchmarkEligible: false,
          benchmarkRunnable: false,
          benchmarkStatus: "unsupported-role",
        }),
      ],
    });
    expect(plan.map((item) => [item.canonicalModel, item.state, item.nextReplicate])).toEqual([
      ["gpt-5.3-codex", "unsupported-role", null],
      ["kimi-k3", "qualified", null],
    ]);
  });

  test("does not schedule a supported role on an unhealthy route", () => {
    const plan = buildLineupBenchmarkPlan({
      schemaVersion: 1,
      benchmarkPolicy: { minimumReplicates: 5 },
      models: [rosterModel({ benchmarkRunnable: false, benchmarkStatus: "held-route" })],
    });
    expect(plan[0]).toMatchObject({ state: "held-route", nextReplicate: null });
  });

  test("holds a completed cohort that still lacks qualified evidence", () => {
    const model = rosterModel();
    const cohortId = cohortIdFor(model);
    const existing = LINEUP_BENCHMARK_SEEDS.map((_, offset) => ({
      cohortId,
      model: model.benchmarkRoute,
      index: offset + 1,
    }));
    const plan = buildLineupBenchmarkPlan({
      schemaVersion: 1,
      benchmarkPolicy: { minimumReplicates: 5 },
      models: [model],
    }, existing);
    expect(plan[0]).toMatchObject({ state: "blocked-complete-unqualified", nextReplicate: null });
  });
});

describe("provider-aware lineup benchmark execution", () => {
  test("maps every supported route prefix to its provider boundary", () => {
    expect(providerForBenchmarkRoute("byok:model-id")).toBe("zo-byok");
    expect(providerForBenchmarkRoute("kimi:kimi-k3")).toBe("kimi");
    expect(providerForBenchmarkRoute("hf:zai-org/GLM-5.2")).toBe("synthetic");
    expect(providerForBenchmarkRoute("syn:zai-org/GLM-5.2")).toBe("synthetic");
    expect(providerForBenchmarkRoute("oc:minimax-m3")).toBe("opencode");
    expect(providerForBenchmarkRoute("or:moonshotai/kimi-k3")).toBe("openrouter");
    expect(providerForBenchmarkRoute("gpt-4o-mini")).toBe("openai");
  });

  test("diversifies each wave while respecting global and provider caps", () => {
    const items = [
      rosterModel({ canonicalModel: "byok-a", benchmarkRoute: "byok:a" }),
      rosterModel({ canonicalModel: "byok-b", benchmarkRoute: "byok:b" }),
      rosterModel({ canonicalModel: "openrouter-a", benchmarkRoute: "or:a" }),
      rosterModel({ canonicalModel: "opencode-a", benchmarkRoute: "oc:a" }),
      rosterModel({ canonicalModel: "synthetic-a", benchmarkRoute: "hf:a" }),
    ];
    const plan = buildLineupBenchmarkPlan({
      schemaVersion: 1,
      benchmarkPolicy: { minimumReplicates: 5 },
      models: items,
    });
    const waves = buildProviderAwareWaves(plan, {
      maxReplicates: 4,
      concurrency: 3,
      providerConcurrency: 1,
    });
    expect(waves.flat()).toHaveLength(4);
    expect(waves[0]!.map((item) => item.canonicalModel)).toEqual(["byok-a", "opencode-a", "openrouter-a"]);
    for (const wave of waves) {
      expect(wave.length).toBeLessThanOrEqual(3);
      expect(new Set(wave.map((item) => providerForBenchmarkRoute(item.benchmarkRoute))).size).toBe(wave.length);
    }
  });

  test("waits for a failed wave and does not start later waves", async () => {
    const first = buildLineupBenchmarkPlan({
      schemaVersion: 1,
      benchmarkPolicy: { minimumReplicates: 5 },
      models: [rosterModel({ canonicalModel: "first", benchmarkRoute: "or:first" })],
    })[0]!;
    const second = { ...first, canonicalModel: "second", benchmarkRoute: "oc:second" };
    const later = { ...first, canonicalModel: "later", benchmarkRoute: "hf:later" };
    const started: string[] = [];
    await expect(runProviderAwareWaves([[first, second], [later]], async (item) => {
      started.push(item.canonicalModel);
      if (item.canonicalModel === "second") throw new Error("provider unavailable");
    })).rejects.toThrow("later waves were not started");
    expect(started).toEqual(["first", "second"]);
  });
});

describe("lineup replicate artifact admission", () => {
  function artifact(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 2,
      run: { run_id: "run-1", benchmark: "ZouroBench", timestamp: "2026-08-04T18:00:00.000Z" },
      cohort: { cohort_id: "cohort-1", replicate_index: 1, replicate_seed: 101, minimum_n: 5 },
      execution: {
        answer_model: "or:test/model",
        judge_model: { value: "gpt-4o", availability_reason: null },
        embedding_model: { value: "text-embedding-3-small", availability_reason: null },
        max_tokens: 512,
        truncation_guard_enabled: true,
      },
      totals: { total_questions: 45, answered: 45 },
      scores: { overall_accuracy: 95 },
      provenance: {
        dataset_sha256: "sha256:dataset",
        question_set_sha256: "sha256:questions",
        adapter_version: "2.0.0",
      },
      ...overrides,
    };
  }

  test("admits only full evidence-compatible deterministic replicates", () => {
    expect(parseExistingReplicateArtifact(artifact())).toEqual({
      cohortId: "cohort-1",
      model: "or:test/model",
      index: 1,
    });
    expect(parseExistingReplicateArtifact(artifact({ totals: { total_questions: 3, answered: 3 } }))).toBeNull();
    expect(parseExistingReplicateArtifact(artifact({
      cohort: { cohort_id: "cohort-1", replicate_index: 1, replicate_seed: 202, minimum_n: 5 },
    }))).toBeNull();
    expect(parseExistingReplicateArtifact(artifact({ provenance: {} }))).toBeNull();
  });
});
