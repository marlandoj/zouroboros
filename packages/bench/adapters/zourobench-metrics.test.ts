import { describe, expect, test } from "bun:test";
import {
  aggregateUsage,
  computeCitationGroundedness,
  computeRetrievalQuality,
  createUsageRecord,
} from "./zourobench-metrics";

describe("computeRetrievalQuality", () => {
  test("reports recall, reciprocal rank, and normalized discounted gain", () => {
    const result = computeRetrievalQuality(
      ["alpha beta", "gamma delta", "epsilon"],
      "alpha gamma",
      [1, 3],
    );
    expect(result.recall_at_k).toEqual({ "1": 0.5, "3": 1 });
    expect(result.mrr).toBe(1);
    expect(result.ndcg_at_k["1"]).toBe(1);
    expect(result.ndcg_at_k["3"]).toBeGreaterThan(0.9);
  });
});

describe("computeCitationGroundedness", () => {
  test("penalizes missing and invalid citations at claim level", () => {
    const result = computeCitationGroundedness(
      "Alpha is true. [C1]\nGamma is true [C2].\nUnknown. [C9]",
      ["alpha is true", "gamma is true"],
    );
    expect(result.claims).toBe(3);
    expect(result.valid_citations).toBe(2);
    expect(result.citation_precision).toBe(0.6667);
    expect(result.citation_coverage).toBe(0.6667);
    expect(result.citation_groundedness).toBe(0.6667);
  });
});

describe("usage metrics", () => {
  test("preserves provider token counts and calculates known-model cost", () => {
    const record = createUsageRecord({
      provider: "openai",
      model: "gpt-4o-mini",
      operation: "answer",
      prompt: "ignored",
      output: "ignored",
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
    });
    expect(record.estimated).toBe(false);
    expect(record.cost_usd).toBe(0.75);
    expect(aggregateUsage([record])).toMatchObject({
      total_tokens: 2_000_000,
      exact_tokens: 2_000_000,
      estimated_tokens: 0,
      priced_cost_usd: 0.75,
    });
  });

  test("prices exact direct and OpenRouter Kimi K3 model ids", () => {
    for (const model of ["kimi:kimi-k3", "or:moonshotai/kimi-k3"]) {
      const record = createUsageRecord({
        provider: model.startsWith("kimi:") ? "kimi" : "openrouter",
        model,
        operation: "answer",
        prompt: "ignored",
        output: "ignored",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      });
      expect(record).toMatchObject({ estimated: false, cost_usd: 18 });
    }
  });

  test("prices exact OpenRouter frontier model ids", () => {
    const expected = new Map([
      ["or:x-ai/grok-4.5", 8],
      ["or:z-ai/glm-5.2", 4.64],
      ["or:qwen/qwen3.6-27b", 2.3],
      ["or:nvidia/nemotron-3-super-120b-a12b", 0.485],
    ]);
    for (const [model, cost] of expected) {
      const record = createUsageRecord({
        provider: "openrouter",
        model,
        operation: "answer",
        prompt: "ignored",
        output: "ignored",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      });
      expect(record).toMatchObject({ estimated: false, cost_usd: cost });
    }
  });

  test("marks fallback token counts and unknown model prices honestly", () => {
    const record = createUsageRecord({
      provider: "zo",
      model: "byok:example",
      operation: "answer",
      prompt: "12345678",
      output: "1234",
    });
    expect(record).toMatchObject({ estimated: true, input_tokens: 2, output_tokens: 1, cost_usd: null });
    expect(aggregateUsage([record]).unpriced_calls).toBe(1);
  });
});
