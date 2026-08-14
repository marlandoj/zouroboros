import { describe, it, expect } from "bun:test";
import {
  percentile,
  tierStats,
  evaluateRun,
  syntheticDispatch,
  type SustainCall,
  type SustainSeed,
  type Tier,
} from "../scripts/sustain";

const SEED: SustainSeed = {
  metadata: { name: "test", version: "0", description: "", purpose: "" },
  defaults: { mode: "synthetic", cadenceSeconds: 300, durationSeconds: 86400, failureBudget: 0.05, driftThreshold: 0.15, syntheticTickMs: 1 },
  chain: {
    primary: "p",
    primaryLabel: "P",
    rungs: [
      { model: "m1", label: "Sonnet", tier: "proprietary" },
      { model: "m2", label: "Kimi", tier: "open-weight" },
      { model: "m3", label: "Smart", tier: "zo-native" },
    ],
  },
  tasks: [{ id: "t1", prompt: "x", expectedKeywords: [], minLength: 0 }],
};

function call(tickSeconds: number, tier: Tier, ok: boolean, passesGate: boolean, latencyMs = 100): SustainCall {
  return { tickSeconds, taskId: "t", rungLabel: "L", tier, ok, latencyMs, passesGate, error: ok ? undefined : "x" };
}

describe("percentile", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
  it("computes p50", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
  it("computes p95", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(vals, 0.95)).toBe(96);
  });
  it("clamps last index", () => {
    expect(percentile([10, 20, 30], 0.99)).toBe(30);
  });
});

describe("tierStats", () => {
  const duration = 86400;

  it("returns zeros for tier with no calls", () => {
    const s = tierStats([], "open-weight", duration);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.drift).toBe(0);
  });

  it("computes pass rate, failure rate, p50/p95 latency", () => {
    const calls = [
      call(0, "proprietary", true, true, 100),
      call(0, "proprietary", true, true, 200),
      call(0, "proprietary", true, false, 300),
      call(0, "proprietary", false, false, 400),
    ];
    const s = tierStats(calls, "proprietary", duration);
    expect(s.total).toBe(4);
    expect(s.passes).toBe(2);
    expect(s.passRate).toBe(0.5);
    expect(s.failureRate).toBe(0.25);
    expect(s.p50LatencyMs).toBe(300);
    expect(s.p95LatencyMs).toBe(400);
  });

  it("computes drift as last-hour minus first-hour pass rate", () => {
    const calls = [
      // first hour: 2/2 pass
      call(0, "proprietary", true, true),
      call(1800, "proprietary", true, true),
      // last hour: 1/2 pass
      call(duration - 1800, "proprietary", true, false),
      call(duration - 600, "proprietary", true, true),
    ];
    const s = tierStats(calls, "proprietary", duration);
    expect(s.firstHourPassRate).toBe(1);
    expect(s.lastHourPassRate).toBe(0.5);
    expect(s.drift).toBeCloseTo(-0.5, 5);
  });

  it("emits drift=0 (no signal) when last-hour window is empty", () => {
    const calls = [call(0, "proprietary", true, true), call(1800, "proprietary", true, true)];
    const s = tierStats(calls, "proprietary", duration);
    expect(s.firstHourPassRate).toBe(1);
    expect(s.lastHourPassRate).toBe(0);
    expect(s.drift).toBe(0);
  });
});

describe("evaluateRun", () => {
  const duration = 86400;
  const budget = 0.05;
  const driftThr = 0.15;

  it("passes when budget OK and drift OK", () => {
    const calls = [
      call(0, "proprietary", true, true),
      call(duration - 600, "proprietary", true, true),
    ];
    const r = evaluateRun(calls, duration, budget, driftThr);
    expect(r.budgetOk).toBe(true);
    expect(r.driftOk).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("fails when failure rate exceeds budget", () => {
    const calls = [
      call(0, "proprietary", false, false),
      call(0, "proprietary", false, false),
      call(0, "proprietary", true, true),
    ];
    const r = evaluateRun(calls, duration, budget, driftThr);
    expect(r.overallFailureRate).toBeCloseTo(2 / 3, 5);
    expect(r.budgetOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("fails when any tier drifts below -driftThreshold", () => {
    const calls = [
      // proprietary: 100% first hour, 0% last hour → drift -1.0
      call(0, "proprietary", true, true),
      call(duration - 600, "proprietary", true, false),
    ];
    const r = evaluateRun(calls, duration, budget, driftThr);
    expect(r.driftOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("ignores empty tiers in drift check", () => {
    const calls = [call(0, "proprietary", true, true)];
    const r = evaluateRun(calls, duration, budget, driftThr);
    expect(r.driftOk).toBe(true);
  });
});

describe("syntheticDispatch (end-to-end synthetic-mode)", () => {
  it("produces deterministic results given a seed", () => {
    const a = syntheticDispatch(SEED, 86400, 3600, { rngSeed: 7 });
    const b = syntheticDispatch(SEED, 86400, 3600, { rngSeed: 7 });
    expect(a.length).toBe(b.length);
    expect(a[0]).toEqual(b[0]);
  });

  it("emits one call per rung per tick", () => {
    // 24h / 1h cadence = 24 ticks × 3 rungs = 72 calls
    const calls = syntheticDispatch(SEED, 86400, 3600);
    expect(calls.length).toBe(72);
  });

  it("respects failure-rate parameter", () => {
    const calls = syntheticDispatch(SEED, 86400, 3600, { failureRate: 0, rngSeed: 1 });
    expect(calls.every((c) => c.ok)).toBe(true);
  });

  it("synthesized run with healthy params passes evaluateRun", () => {
    const calls = syntheticDispatch(SEED, 86400, 300, {
      baselinePassRate: 0.98,
      driftPerHour: -0.001,
      failureRate: 0.01,
      rngSeed: 99,
    });
    const r = evaluateRun(calls, 86400, 0.05, 0.15);
    expect(r.budgetOk).toBe(true);
    expect(r.driftOk).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("synthesized run with steep drift fails evaluateRun", () => {
    const calls = syntheticDispatch(SEED, 86400, 300, {
      baselinePassRate: 1.0,
      driftPerHour: -0.05, // -100% over 20h
      failureRate: 0,
      rngSeed: 99,
    });
    const r = evaluateRun(calls, 86400, 0.05, 0.15);
    expect(r.driftOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("synthesized run with high failure rate breaks budget", () => {
    const calls = syntheticDispatch(SEED, 86400, 300, {
      baselinePassRate: 1.0,
      failureRate: 0.2,
      rngSeed: 99,
    });
    const r = evaluateRun(calls, 86400, 0.05, 0.15);
    expect(r.budgetOk).toBe(false);
    expect(r.pass).toBe(false);
  });
});
