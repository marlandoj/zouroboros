import { describe, expect, test } from "bun:test";
import {
  authorModel,
  buildEvidenceManifest,
  buildRepairPrompt,
  parseConsensusOutput,
  parseModelJson,
  researchConsensusTimeoutMs,
  type GateDecision,
} from "./research-models";
import {
  DEFAULT_PRODUCTION_MOA_LINEUP,
  resolveProductionMoaLineup,
} from "../../consensus-gate/scripts/moa-runtime";

describe("research model adapter", () => {
  test("uses a bounded deep-research reviewer timeout", () => {
    expect(researchConsensusTimeoutMs()).toBeGreaterThanOrEqual(60_000);
    expect(researchConsensusTimeoutMs()).toBeLessThanOrEqual(12 * 60_000);
  });

  test("limits quality-review evidence to cited sources", () => {
    const manifest = buildEvidenceManifest([
      { id: "S1", type: "web", title: "Used", url: "https://used.test", text: "used evidence" },
      { id: "S2", type: "web", title: "Unused", url: "https://unused.test", text: "unused evidence" },
    ], [{ sourceIds: ["S1"] }]);

    expect(manifest).toContain("[S1]");
    expect(manifest).toContain("used evidence");
    expect(manifest).not.toContain("[S2]");
    expect(manifest).not.toContain("unused evidence");
    expect(manifest).toContain("1 uncited sources omitted");
  });

  test("extracts JSON even when prose and quoted braces surround it", () => {
    const parsed = parseModelJson<{ value: string }>('Result: {"value":"a } brace"}\nDone');
    expect(parsed).toEqual({ value: "a } brace" });
  });

  test("normalizes Consensus Gate evidence and objections", () => {
    const raw = {
      id: "cg-test",
      status: "rejected",
      consensus: { pass: false, confidence: 0.81 },
      lineup_source: "dynamic",
      panel_fingerprint: "panel-123",
      excluded_author: "aggregator/model",
      verdicts: [
        { issues: ["Citation S9 is unsupported"], dissent_claims: [] },
        { issues: ["Citation S9 is unsupported"], dissent_claims: [{ claim: "Missing counterevidence" }] },
      ],
    };
    const decision = parseConsensusOutput(`log\n__CG_JSON__${JSON.stringify(raw)}\n`);
    expect(decision).toMatchObject({
      consensus_id: "cg-test",
      status: "rejected",
      pass: false,
      confidence: 0.81,
      lineup_source: "dynamic",
      panel_fingerprint: "panel-123",
      excluded_author: "aggregator/model",
    });
    expect(decision.objections).toEqual(["Citation S9 is unsupported", "Missing counterevidence"]);
  });

  test("grounds a single repair prompt in gate and local objections", () => {
    const gate: GateDecision = {
      consensus_id: "cg-test",
      status: "escalate",
      pass: false,
      confidence: 0.5,
      objections: ["Evidence coverage is incomplete"],
      raw: {},
    };
    const prompt = buildRepairPrompt({
      query: "What changed?",
      draft: "Draft [S1]",
      sourceManifest: "[S1] Source text",
      gate,
      localObjections: ["Unknown citation [S2]"],
    });
    expect(prompt).toContain("Evidence coverage is incomplete");
    expect(prompt).toContain("Unknown citation [S2]");
    expect(prompt).toContain("[S1] Source text");
    expect(prompt).toContain("Draft [S1]");
  });

  test("uses the MoA aggregator as the author identity", () => {
    expect(authorModel({
      provider: "moa",
      model: "moa(fallback)",
      latency_ms: 1,
      cost_usd: 0,
      aggregator_used: "aggregator/model",
    })).toBe("aggregator/model");
  });

  test("resolves research through MoA and keeps fallback roles distinct", () => {
    const lineup = resolveProductionMoaLineup(DEFAULT_PRODUCTION_MOA_LINEUP, {
      env: {},
      lineupPath: "/nonexistent/deep-research-lineup.json",
    });
    expect(lineup.source).toBe("fallback");
    expect(lineup.proposers).toEqual(DEFAULT_PRODUCTION_MOA_LINEUP.proposers);
    expect(lineup.aggregator).toBe(DEFAULT_PRODUCTION_MOA_LINEUP.aggregator);
    expect(DEFAULT_PRODUCTION_MOA_LINEUP.proposers).not.toContain(DEFAULT_PRODUCTION_MOA_LINEUP.aggregator);
  });
});
