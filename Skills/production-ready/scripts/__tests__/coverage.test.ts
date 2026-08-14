import { test, expect, describe } from "bun:test";
import { assessCoverage, inferCoverage, worst } from "../lib/coverage.ts";
import type { CheckResult, AuditConfig, Domain, DomainCoverage } from "../lib/types.ts";

function result(domain: Domain, over: Partial<CheckResult> = {}): CheckResult {
  return {
    domain,
    ranAt: new Date().toISOString(),
    durationMs: 1,
    toolsUsed: ["production-ready:x"],
    toolsMissing: [],
    findings: [],
    manualChecklist: [],
    ...over,
  };
}

const allScanners = { gitleaks: { available: true }, semgrep: { available: true }, "osv-scanner": { available: true } };
const noScanners = { gitleaks: { available: false }, semgrep: { available: false }, "osv-scanner": { available: false } };

function cfg(over: Partial<AuditConfig> = {}): AuditConfig {
  return { outDir: "/tmp", format: "json", url: "https://x.test", ...over };
}

describe("worst()", () => {
  test("picks the more severe verdict", () => {
    expect(worst("launch-ready", "private-beta-only")).toBe("private-beta-only");
    expect(worst("do-not-launch", "launch-with-monitoring")).toBe("do-not-launch");
    expect(worst("launch-ready", "launch-ready")).toBe("launch-ready");
  });
});

describe("inferCoverage()", () => {
  test("errored domain → not-run", () => {
    expect(inferCoverage(result("owasp", { error: "boom" })).status).toBe("not-run");
  });
  test("explicit coverage is respected", () => {
    const c: DomainCoverage = { status: "fail", reason: "no url" };
    expect(inferCoverage(result("browser-test", { coverage: c }))).toEqual(c);
  });
  test("no tools used + missing tools → partial", () => {
    expect(inferCoverage(result("owasp", { toolsUsed: [], toolsMissing: ["semgrep"] })).status).toBe("partial");
  });
  test("worked normally → pass", () => {
    expect(inferCoverage(result("owasp")).status).toBe("pass");
  });
});

describe("assessCoverage()", () => {
  test("all scanners + url + no critical manual → complete, launch-ready ceiling", () => {
    const cov = assessCoverage({ results: [result("owasp")], tooling: allScanners, config: cfg() });
    expect(cov.incomplete).toBe(false);
    expect(cov.ceiling).toBe("launch-ready");
    expect(cov.gaps.length).toBe(0);
  });

  test("≥2 core scanners missing → blocking gap, private-beta ceiling", () => {
    const cov = assessCoverage({ results: [result("owasp")], tooling: noScanners, config: cfg() });
    expect(cov.missingScanners.length).toBe(3);
    expect(cov.ceiling).toBe("private-beta-only");
    expect(cov.gaps.some((g) => g.severity === "blocking")).toBe(true);
  });

  test("exactly 1 core scanner missing → soft gap, monitoring ceiling", () => {
    const tooling = { ...allScanners, "osv-scanner": { available: false } };
    const cov = assessCoverage({ results: [result("owasp")], tooling, config: cfg() });
    expect(cov.missingScanners).toEqual(["osv-scanner"]);
    expect(cov.ceiling).toBe("launch-with-monitoring");
  });

  test("errored security-critical domain → blocking", () => {
    const cov = assessCoverage({ results: [result("authentication", { error: "x" })], tooling: allScanners, config: cfg() });
    expect(cov.ceiling).toBe("private-beta-only");
  });

  test("errored non-critical domain → soft", () => {
    const cov = assessCoverage({ results: [result("accessibility", { error: "x" })], tooling: allScanners, config: cfg() });
    expect(cov.ceiling).toBe("launch-with-monitoring");
  });

  test("unverified critical manual check → soft gap", () => {
    const r = result("browser-test", { manualChecklist: [{ item: "gate", rationale: "r", critical: true }] });
    const cov = assessCoverage({ results: [r], tooling: allScanners, config: cfg() });
    expect(cov.ceiling).toBe("launch-with-monitoring");
    expect(cov.gaps.some((g) => g.kind === "manual:critical-unverified")).toBe(true);
  });

  test("--manual-verified clears the critical-manual gap", () => {
    const r = result("browser-test", { manualChecklist: [{ item: "gate", rationale: "r", critical: true }] });
    const cov = assessCoverage({ results: [r], tooling: allScanners, config: cfg({ manualVerified: true }) });
    expect(cov.gaps.some((g) => g.kind === "manual:critical-unverified")).toBe(false);
    expect(cov.ceiling).toBe("launch-ready");
  });

  test("riskProfile=regulated escalates a soft gap to private-beta", () => {
    const tooling = { ...allScanners, "osv-scanner": { available: false } };
    const cov = assessCoverage({ results: [result("owasp")], tooling, config: cfg({ policy: { riskProfile: "regulated" } }) });
    expect(cov.ceiling).toBe("private-beta-only");
  });

  test("riskProfile=startup-mvp keeps a blocking gap at monitoring", () => {
    const cov = assessCoverage({ results: [result("owasp")], tooling: noScanners, config: cfg({ policy: { riskProfile: "startup-mvp" } }) });
    expect(cov.ceiling).toBe("launch-with-monitoring");
    // …but still never launch-ready while incomplete
    expect(cov.incomplete).toBe(true);
  });
});
