import { describe, it, expect } from "bun:test";
import { shouldUpdateBaseline, type GateStatus } from "../scripts/regression-gate";

describe("shouldUpdateBaseline — baseline ratchet safety (ZOU-400)", () => {
  it("a FAIL run does NOT promote the baseline (the prior floor stands)", () => {
    expect(shouldUpdateBaseline("fail")).toBe(false);
  });

  it("a WARN run (sub-threshold drift) does NOT promote the baseline", () => {
    expect(shouldUpdateBaseline("warn")).toBe(false);
  });

  it("a clean PASS promotes the baseline", () => {
    expect(shouldUpdateBaseline("pass")).toBe(true);
  });

  it("bootstrap (no prior baseline) always establishes a floor", () => {
    expect(shouldUpdateBaseline("bootstrap")).toBe(true);
  });

  it("--update-baseline overrides a FAIL to deliberately accept the new floor", () => {
    expect(shouldUpdateBaseline("fail", { updateBaseline: true })).toBe(true);
  });

  it("--baseline-only promotes regardless of gate status", () => {
    expect(shouldUpdateBaseline("warn", { baselineOnly: true })).toBe(true);
  });

  it("PASS is the only non-override status that promotes", () => {
    const statuses: GateStatus[] = ["bootstrap", "pass", "warn", "fail"];
    const promoted = statuses.filter((s) => shouldUpdateBaseline(s));
    expect(promoted.sort()).toEqual(["bootstrap", "pass"]);
  });
});
