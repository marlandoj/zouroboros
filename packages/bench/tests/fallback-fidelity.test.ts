import { describe, it, expect } from "bun:test";
import {
  keywordOverlap,
  passesGate,
  aggregateByTier,
  type CallResult,
  type Tier,
} from "../scripts/fallback-fidelity";

describe("keywordOverlap", () => {
  it("returns 1.0 when every keyword is present", () => {
    expect(keywordOverlap("the quick brown fox jumps", ["quick", "fox"])).toBe(1);
  });

  it("returns 0.5 on half-match", () => {
    expect(keywordOverlap("only the brown fox is here", ["brown", "elephant"])).toBe(0.5);
  });

  it("is case-insensitive", () => {
    expect(keywordOverlap("ALICE went to the store", ["alice"])).toBe(1);
  });

  it("returns 1 when keywords list is empty (vacuous match)", () => {
    expect(keywordOverlap("anything", [])).toBe(1);
  });

  it("returns 0 when no keywords match", () => {
    expect(keywordOverlap("nothing here", ["foo", "bar"])).toBe(0);
  });
});

describe("passesGate", () => {
  const task = { expectedKeywords: ["foo", "bar", "baz"], minLength: 20 };

  it("rejects output below minLength even with full keyword match", () => {
    expect(passesGate("foo bar baz", task)).toBe(false);
  });

  it("rejects output with keyword overlap below default 0.4 floor", () => {
    const out = "this is a long enough output but missing the words";
    expect(passesGate(out, task)).toBe(false);
  });

  it("accepts output meeting both gates", () => {
    const out = "this output mentions foo and bar in a long body";
    expect(passesGate(out, task)).toBe(true);
  });

  it("respects custom overlap floor", () => {
    const out = "this long output mentions only one word: foo here";
    expect(passesGate(out, task, 0.3)).toBe(true);
    expect(passesGate(out, task, 0.5)).toBe(false);
  });
});

describe("aggregateByTier", () => {
  const thresholds: Record<Tier, number> = { proprietary: 0.9, "open-weight": 0.7, "zo-native": 0.5 };

  function r(tier: Tier, pass: boolean): CallResult {
    return { taskId: "t", model: "m", label: "L", tier, ok: true, latencyMs: 10, outputLength: 100, keywordOverlap: pass ? 1 : 0, passesGate: pass };
  }

  it("computes pass rates and threshold check per tier", () => {
    const results = [
      r("proprietary", true), r("proprietary", true),
      r("open-weight", true), r("open-weight", false),
      r("zo-native", false), r("zo-native", false),
    ];
    const stats = aggregateByTier(results, thresholds);
    const proprietary = stats.find((s) => s.tier === "proprietary")!;
    const openWeight = stats.find((s) => s.tier === "open-weight")!;
    const zoNative = stats.find((s) => s.tier === "zo-native")!;

    expect(proprietary.rate).toBe(1);
    expect(proprietary.meetsThreshold).toBe(true);
    expect(openWeight.rate).toBe(0.5);
    expect(openWeight.meetsThreshold).toBe(false);
    expect(zoNative.rate).toBe(0);
    expect(zoNative.meetsThreshold).toBe(false);
  });

  it("treats empty tier as meeting threshold (no calls = vacuous pass)", () => {
    const stats = aggregateByTier([r("proprietary", true)], thresholds);
    const openWeight = stats.find((s) => s.tier === "open-weight")!;
    expect(openWeight.total).toBe(0);
    expect(openWeight.meetsThreshold).toBe(true);
  });

  it("flags exact-threshold rates as meeting (>=)", () => {
    const results = [
      r("open-weight", true), r("open-weight", true), r("open-weight", true),
      r("open-weight", true), r("open-weight", true), r("open-weight", true),
      r("open-weight", true), r("open-weight", false), r("open-weight", false), r("open-weight", false),
    ];
    const stats = aggregateByTier(results, { ...thresholds, "open-weight": 0.7 });
    const openWeight = stats.find((s) => s.tier === "open-weight")!;
    expect(openWeight.rate).toBe(0.7);
    expect(openWeight.meetsThreshold).toBe(true);
  });
});
