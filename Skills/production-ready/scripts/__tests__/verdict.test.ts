import { test, expect, describe } from "bun:test";
import { computeVerdict } from "../lib/verdict.ts";
import type { Finding, CoverageReport, Severity } from "../lib/types.ts";

function finding(severity: Severity, hardBlocker = false): Finding {
  return {
    id: `t.${severity}.${Math.random().toString(36).slice(2)}`,
    domain: "owasp",
    severity,
    title: `${severity} finding`,
    description: "x",
    remediation: "y",
    source: "test",
    hardBlocker,
  };
}

function coverage(ceiling: CoverageReport["ceiling"], gaps: CoverageReport["gaps"] = []): CoverageReport {
  return {
    perDomain: [],
    gaps,
    missingScanners: [],
    ceiling,
    incomplete: ceiling !== "launch-ready",
  };
}

describe("findings gate (no coverage)", () => {
  test("clean → launch-ready", () => {
    const v = computeVerdict([]);
    expect(v.verdict).toBe("launch-ready");
    expect(v.exitCode).toBe(0);
  });

  test("a critical → do-not-launch", () => {
    const v = computeVerdict([finding("critical")]);
    expect(v.verdict).toBe("do-not-launch");
    expect(v.exitCode).toBe(3);
    expect(v.hardBlockers.length).toBe(1);
  });

  test("hardBlocker on a high → do-not-launch", () => {
    const v = computeVerdict([finding("high", true)]);
    expect(v.verdict).toBe("do-not-launch");
  });

  test("a high → private-beta-only", () => {
    const v = computeVerdict([finding("high")]);
    expect(v.verdict).toBe("private-beta-only");
    expect(v.exitCode).toBe(2);
  });

  test("> 3 medium → launch-with-monitoring", () => {
    const v = computeVerdict([finding("medium"), finding("medium"), finding("medium"), finding("medium")]);
    expect(v.verdict).toBe("launch-with-monitoring");
    expect(v.exitCode).toBe(1);
  });

  test("maxMedium override raises the boundary", () => {
    const four = [finding("medium"), finding("medium"), finding("medium"), finding("medium")];
    expect(computeVerdict(four, undefined, { maxMedium: 5 }).verdict).toBe("launch-ready");
  });
});

describe("coverage gate — the false-green fix", () => {
  test("REGRESSION: clean findings but incomplete coverage must NOT be launch-ready", () => {
    const v = computeVerdict(
      [],
      coverage("private-beta-only", [
        { kind: "scanners:multiple-missing", severity: "blocking", detail: "8 of 9 scanners unavailable" },
      ]),
    );
    expect(v.verdict).not.toBe("launch-ready");
    expect(v.verdict).toBe("private-beta-only");
    expect(v.cappedByCoverage).toBe(true);
    expect(v.findingsVerdict).toBe("launch-ready");
    expect(v.exitCode).toBe(2);
  });

  test("soft-only coverage gap caps at launch-with-monitoring", () => {
    const v = computeVerdict([], coverage("launch-with-monitoring", [
      { kind: "no-url", severity: "soft", detail: "no url" },
    ]));
    expect(v.verdict).toBe("launch-with-monitoring");
    expect(v.cappedByCoverage).toBe(true);
  });

  test("complete coverage does not cap a clean result", () => {
    const v = computeVerdict([], coverage("launch-ready"));
    expect(v.verdict).toBe("launch-ready");
    expect(v.cappedByCoverage).toBe(false);
  });

  test("verdict is the WORST of findings and coverage — findings can still be worse", () => {
    // do-not-launch findings + merely private-beta coverage ceiling → do-not-launch
    const v = computeVerdict([finding("critical")], coverage("private-beta-only", [
      { kind: "x", severity: "blocking", detail: "d" },
    ]));
    expect(v.verdict).toBe("do-not-launch");
    expect(v.cappedByCoverage).toBe(false); // findings drove it, not coverage
  });

  test("reason explains the cap when coverage wins", () => {
    const v = computeVerdict([], coverage("private-beta-only", [
      { kind: "scanners:multiple-missing", severity: "blocking", detail: "scanners missing" },
    ]));
    expect(v.reason).toContain("incomplete");
    expect(v.reason.toLowerCase()).toContain("capped");
  });
});
