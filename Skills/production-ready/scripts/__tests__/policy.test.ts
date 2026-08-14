import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPolicy, loadPolicy, maxMediumThreshold, mergePolicyIntoConfig } from "../lib/policy.ts";
import type { Finding, AuditConfig, Severity, Domain } from "../lib/types.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "frontend.internal-url.docs/example.tsx.12",
    domain: "frontend",
    severity: "low",
    title: "t",
    description: "d",
    remediation: "r",
    source: "s",
    ...over,
  };
}

describe("applyPolicy()", () => {
  test("no policy → passthrough", () => {
    const f = [finding()];
    expect(applyPolicy(f, undefined)).toBe(f);
  });

  test("suppress by exact finding id", () => {
    const out = applyPolicy([finding()], { ignore: { findingIds: ["frontend.internal-url.docs/example.tsx.12"] } });
    expect(out.length).toBe(0);
  });

  test("suppress by id substring", () => {
    const out = applyPolicy([finding()], { ignore: { findingIds: ["internal-url"] } });
    expect(out.length).toBe(0);
  });

  test("filePattern drops finding only when ALL evidence is ignored", () => {
    const inExamples = finding({ id: "a", evidence: [{ file: "examples/x.tsx", line: 1 }] });
    const mixed = finding({ id: "b", evidence: [{ file: "examples/x.tsx" }, { file: "src/real.tsx" }] });
    const out = applyPolicy([inExamples, mixed], { ignore: { filePatterns: ["examples/**"] } });
    expect(out.map((f) => f.id)).toEqual(["b"]);
  });

  test("per-domain severity floor drops below-floor findings", () => {
    const low = finding({ id: "low", domain: "frontend", severity: "low" });
    const high = finding({ id: "high", domain: "frontend", severity: "high" });
    const out = applyPolicy([low, high], { thresholds: { perDomain: { frontend: "medium" as Severity } } });
    expect(out.map((f) => f.id)).toEqual(["high"]);
  });
});

describe("maxMediumThreshold()", () => {
  test("explicit value wins", () => {
    expect(maxMediumThreshold({ thresholds: { maxMedium: 9 } })).toBe(9);
  });
  test("profile defaults", () => {
    expect(maxMediumThreshold(undefined)).toBe(3);
    expect(maxMediumThreshold({ riskProfile: "startup-mvp" })).toBe(5);
    expect(maxMediumThreshold({ riskProfile: "regulated" })).toBe(1);
  });
});

describe("loadPolicy()", () => {
  test("parses JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-policy-"));
    const p = join(dir, "audit.config.json");
    writeFileSync(p, JSON.stringify({ riskProfile: "regulated", asvs: { version: "4.0.3" } }));
    const policy = loadPolicy(p);
    expect(policy.riskProfile).toBe("regulated");
    expect(policy.asvs?.version).toBe("4.0.3");
  });

  test("rejects YAML with a clear error", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-policy-"));
    const p = join(dir, "audit.config.yaml");
    writeFileSync(p, "riskProfile: regulated\n");
    expect(() => loadPolicy(p)).toThrow(/YAML/);
  });
});

describe("mergePolicyIntoConfig()", () => {
  test("policy fills unset fields; CLI values win", () => {
    const config: AuditConfig = { outDir: "/tmp", format: "json", appName: "cli-name" };
    mergePolicyIntoConfig(config, {
      appName: "policy-name",
      url: "https://staging.test",
      surfaces: { payments: true },
      ignore: { domains: ["legal" as Domain] },
    });
    expect(config.appName).toBe("cli-name"); // CLI wins
    expect(config.url).toBe("https://staging.test"); // filled from policy
    expect(config.surfaces?.payments).toBe(true);
    expect(config.skip).toContain("legal");
  });
});
