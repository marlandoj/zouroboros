import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateScenario,
  runSynthetic,
  pickHealthyFallback,
  classifyRung,
  type Scenario,
  type ScenariosFile,
} from "../scripts/failure-recovery";

const SCENARIOS_PATH = resolve(__dirname, "../data/failure-recovery/scenarios.json");
const scenarios: ScenariosFile = JSON.parse(readFileSync(SCENARIOS_PATH, "utf-8"));
const chainConfig = JSON.parse(readFileSync(scenarios.metadata.fallbackChainPath, "utf-8"));

describe("pickHealthyFallback (pure)", () => {
  it("returns first healthy fallback in order", () => {
    const probes = {
      a: { model: "a", healthy: false, health: "unhealthy" as const, latencyMs: 0, checkedAt: "" },
      b: { model: "b", healthy: true, health: "healthy" as const, latencyMs: 0, checkedAt: "" },
      c: { model: "c", healthy: true, health: "healthy" as const, latencyMs: 0, checkedAt: "" },
    };
    const r = pickHealthyFallback(["a", "b", "c"], probes);
    expect(r.target).toBe("b");
    expect(r.firstHealthyIndex).toBe(1);
    expect(r.probedFallbacks).toBe(2); // a (probed, unhealthy) + b (probed, healthy) — c not visited
  });

  it("returns terminal when no probed fallback is healthy", () => {
    const probes = {
      a: { model: "a", healthy: false, health: "unhealthy" as const, latencyMs: 0, checkedAt: "" },
      b: { model: "b", healthy: false, health: "unhealthy" as const, latencyMs: 0, checkedAt: "" },
    };
    const r = pickHealthyFallback(["a", "b", "zo:smart"], probes, "zo:smart");
    expect(r.target).toBe("zo:smart");
    expect(r.firstHealthyIndex).toBe(-1);
  });

  it("skips unprobed fallbacks (does not assume healthy)", () => {
    const probes = {
      b: { model: "b", healthy: true, health: "healthy" as const, latencyMs: 0, checkedAt: "" },
    };
    const r = pickHealthyFallback(["a", "b"], probes);
    expect(r.target).toBe("b"); // a unprobed, skipped; b probed-healthy
    expect(r.probedFallbacks).toBe(1);
  });

  it("returns terminal when fallbacks list is empty", () => {
    const r = pickHealthyFallback([], {}, "zo:smart");
    expect(r.target).toBe("zo:smart");
    expect(r.firstHealthyIndex).toBe(-1);
  });
});

describe("evaluateScenario", () => {
  it("passes the sonnet-429 scenario", () => {
    const scenario = scenarios.scenarios.find((s) => s.id === "sonnet-429")!;
    const result = evaluateScenario(scenario, chainConfig, scenarios.defaults);
    expect(result.pass).toBe(true);
    expect(result.actual.target).toBe(scenario.expected.target);
    expect(result.actual.rung).toBe("proprietary");
    expect(result.actual.withinRungBudget).toBe(true);
  });

  it("falls through to open-weight when both proprietary rungs are down", () => {
    const scenario = scenarios.scenarios.find((s) => s.id === "sonnet-402-gemini-also-down")!;
    const result = evaluateScenario(scenario, chainConfig, scenarios.defaults);
    expect(result.pass).toBe(true);
    expect(result.actual.rung).toBe("open-weight");
    expect(result.actual.withinRungBudget).toBe(true);
  });

  it("falls through to terminal zo:smart only when every rung is down (out-of-budget)", () => {
    const scenario = scenarios.scenarios.find((s) => s.id === "all-fallbacks-down")!;
    const result = evaluateScenario(scenario, chainConfig, scenarios.defaults);
    expect(result.pass).toBe(true);
    expect(result.actual.rung).toBe("zo-native");
    expect(result.actual.withinRungBudget).toBe(false);
  });

  it("flags an unknown primary as a chain-config gap", () => {
    const bogus: Scenario = {
      id: "bogus",
      description: "primary not in chains",
      primary: "nonexistent-model",
      probeResults: {},
      expected: { target: "zo:smart", rung: "zo-native", withinRungBudget: false, firstHealthyIndex: -1 },
    };
    const result = evaluateScenario(bogus, chainConfig, scenarios.defaults);
    expect(result.pass).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("no fallback chain registered"))).toBe(true);
  });

  it("detects target-mismatch and reports it", () => {
    const scenario = scenarios.scenarios.find((s) => s.id === "sonnet-429")!;
    const tampered: Scenario = { ...scenario, expected: { ...scenario.expected, target: "byok:00000000-0000-4000-8000-000000000004", rung: "open-weight" } };
    const result = evaluateScenario(tampered, chainConfig, scenarios.defaults);
    expect(result.pass).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("target mismatch"))).toBe(true);
  });
});

describe("runSynthetic", () => {
  it("passes all packaged scenarios end-to-end (within failure budget)", () => {
    const report = runSynthetic(scenarios, chainConfig);
    expect(report.passOverall).toBe(true);
    expect(report.scenariosPassed).toBe(report.scenariosTotal);
    expect(report.failureRate).toBeLessThanOrEqual(report.failureBudget);
  });

  it("filters by --scenario id", () => {
    const report = runSynthetic(scenarios, chainConfig, "sonnet-429");
    expect(report.scenariosTotal).toBe(1);
    expect(report.scenarios[0].id).toBe("sonnet-429");
  });

  it("fails OVERALL when injected expectation drifts (bench gate works)", () => {
    const sabotaged: ScenariosFile = {
      ...scenarios,
      scenarios: [
        {
          ...scenarios.scenarios[0],
          expected: { ...scenarios.scenarios[0].expected, target: "wrong-target" },
        },
      ],
    };
    const report = runSynthetic(sabotaged, chainConfig);
    expect(report.passOverall).toBe(false);
    expect(report.scenariosPassed).toBe(0);
  });
});

describe("classifyRung", () => {
  it("classifies current opaque BYOK rungs from their labels", () => {
    expect(classifyRung("byok:kimi", "BYOK Kimi K2.6 (synthetic.new)")).toBe("open-weight");
    expect(classifyRung("byok:gemini", "Gemini 3.1 Pro (OpenRouter)")).toBe("proprietary");
  });
});
