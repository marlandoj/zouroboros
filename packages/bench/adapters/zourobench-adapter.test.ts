import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertEmbeddingCoverage,
  assertJudgeCredential,
  isHealthyProvenProfileResult,
  parseProfileValveOutput,
  resolveReplicatePlan,
  resolveValveWithFlagshipFallback,
} from "./zourobench-adapter";

describe("benchmark capability preflight", () => {
  test("fails closed when an LLM judge is requested without its credential", () => {
    expect(() => assertJudgeCredential(true, "")).toThrow("--judge requires OPENAI_API_KEY");
    expect(() => assertJudgeCredential(true, "   ")).toThrow("--judge requires OPENAI_API_KEY");
    expect(() => assertJudgeCredential(false, "")).not.toThrow();
  });

  test("fails closed when a declared LLM-judge run has incomplete embeddings", () => {
    expect(() => assertEmbeddingCoverage(true, 64, 0)).toThrow("expected 64, observed 0");
    expect(() => assertEmbeddingCoverage(true, 64, 63)).toThrow("expected 64, observed 63");
    expect(() => assertEmbeddingCoverage(true, 64, 64)).not.toThrow();
    expect(() => assertEmbeddingCoverage(false, 64, 0)).not.toThrow();
  });
});

describe("replicate continuation planning", () => {
  test("preserves the canonical five-run cohort while resuming at replicate three", () => {
    expect(resolveReplicatePlan({
      runs: "3",
      replicateSeeds: "s3,s4,s5",
      minimumN: "5",
      replicateStart: "3",
      cohortRuns: "5",
      cohortReplicateSeeds: "s1,s2,s3,s4,s5",
    })).toEqual({
      totalRuns: 3,
      minimumN: 5,
      replicateSeeds: ["s3", "s4", "s5"],
      replicateStart: 3,
      cohortRuns: 5,
      cohortReplicateSeeds: ["s1", "s2", "s3", "s4", "s5"],
    });
  });

  test("rejects a resumed seed slice that does not match the canonical cohort", () => {
    expect(() => resolveReplicatePlan({
      runs: "2",
      replicateSeeds: "wrong,s4",
      minimumN: "5",
      replicateStart: "3",
      cohortRuns: "5",
      cohortReplicateSeeds: "s1,s2,s3,s4,s5",
    })).toThrow("must match the resumed slice");
  });
});

function output(overrides: Record<string, unknown> = {}): string {
  const payload = {
    valveRunId: "pv-test",
    requestedMode: "shadow",
    effectiveMode: "shadow",
    decisionSource: "flagship",
    decision: { status: "rejected", consensus: { confidence: 0.91 } },
    trigger: "forced_shadow",
    escalated: false,
    severeMiss: true,
    totalLatencyMs: 42,
    fast: { consensusId: "cg-fast", gateRunId: "gate-fast", latencyMs: 12 },
    flagship: { consensusId: "cg-flagship", gateRunId: "gate-flagship", latencyMs: 30 },
    ...overrides,
  };
  return `diagnostic output\n__PROFILE_VALVE_JSON__${JSON.stringify(payload)}\n`;
}

describe("parseProfileValveOutput", () => {
  test("returns the Flagship verdict and attributable shadow metadata", () => {
    expect(parseProfileValveOutput(output())).toEqual({
      verdict: "rejected",
      confidence: 0.91,
      metadata: {
        valve_run_id: "pv-test",
        trigger: "forced_shadow",
        escalated: false,
        decision_source: "flagship",
        severe_miss: true,
        total_latency_ms: 42,
        fast: { consensus_id: "cg-fast", gate_run_id: "gate-fast", latency_ms: 12 },
        flagship: { consensus_id: "cg-flagship", gate_run_id: "gate-flagship", latency_ms: 30 },
      },
    });
  });

  test("maps the gate's escalate status to the adapter's split semantics", () => {
    const decision = { status: "escalate", consensus: { confidence: 0.5 } };
    expect(parseProfileValveOutput(output({ decision })).verdict).toBe("split");
  });

  test("rejects a non-Flagship or malformed shadow decision", () => {
    expect(() => parseProfileValveOutput(output({ decisionSource: "fast" }))).toThrow("non-Flagship");
    expect(() => parseProfileValveOutput("no sentinel")).toThrow("no JSON sentinel");
  });
});

describe("resolveValveWithFlagshipFallback", () => {
  test("keeps a successful Flagship-authoritative valve result", async () => {
    let fallbackCalls = 0;
    const valve = { verdict: "passed", confidence: 0.9 };
    expect(await resolveValveWithFlagshipFallback(valve, async () => {
      fallbackCalls++;
      return { verdict: "rejected", confidence: 1 };
    })).toBe(valve);
    expect(fallbackCalls).toBe(0);
  });

  test("invokes direct Flagship when the valve process fails", async () => {
    let fallbackCalls = 0;
    const output = await resolveValveWithFlagshipFallback(
      { verdict: "error", confidence: 0.5, error: "missing sentinel" },
      async () => {
        fallbackCalls++;
        return { verdict: "rejected", confidence: 0.93 };
      },
    );
    expect(output).toEqual({ verdict: "rejected", confidence: 0.93 });
    expect(fallbackCalls).toBe(1);
  });
});

describe("isHealthyProvenProfileResult", () => {
  test("rejects an arbiter-masked Flagship panel outage", () => {
    const panel = ["flagship-a", "flagship-b", "flagship-c"];
    const payload = {
      lineup_profile: "flagship",
      lineup_source: "persisted-profile",
      panel,
      panel_fingerprint: createHash("sha256").update(JSON.stringify(panel)).digest("hex"),
      status: "rejected",
      consensus: { confidence: 0.25, unanimous: false },
      verdicts: [
        ...panel.map((model) => ({ model, confidence: 0, issues: ["API error: 503"] })),
        { model: "non-llm/arbiter-v1", confidence: 1, issues: [] },
      ],
    };
    expect(isHealthyProvenProfileResult(payload, "flagship")).toBe(false);
    payload.verdicts = panel.map((model) => ({ model, confidence: 0.9, issues: [] }));
    expect(isHealthyProvenProfileResult(payload, "flagship")).toBe(true);
  });
});
