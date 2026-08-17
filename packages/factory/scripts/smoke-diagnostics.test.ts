import { describe, expect, test } from "bun:test";
import { bunTestFailureDetail, hermeticSmokeProbeEnv } from "./smoke-diagnostics";

describe("Bun smoke diagnostics", () => {
  test("keeps the actionable filesystem error instead of the timing summary", () => {
    const detail = bunTestFailureDetail(1, "bun test v1.2.21", [
      "ENOENT: no such file or directory, open '/tmp/audit.jsonl'",
      "(fail) factory plan gate > records shadow evidence",
      "Ran 5 tests across 1 file. [44.00ms]",
    ].join("\n"));
    expect(detail).toContain("ENOENT");
    expect(detail).not.toContain("Ran 5 tests");
  });

  test("keeps module resolution failures", () => {
    const detail = bunTestFailureDetail(1, "", [
      "error: Cannot find module 'zouroboros-workflow/plan-gate'",
      "(fail) shadow mode appends an auditable record",
      "Ran 6 tests across 1 file. [100.00ms]",
    ].join("\n"));
    expect(detail).toContain("Cannot find module");
  });

  test("falls back to the failed test name", () => {
    const detail = bunTestFailureDetail(1, "", [
      "(fail) factory plan gate > rejects invalid evidence",
      "Ran 1 test across 1 file. [10.00ms]",
    ].join("\n"));
    expect(detail).toBe("(fail) factory plan gate > rejects invalid evidence");
  });

  test("reports the exit code when the runner emitted nothing", () => {
    expect(bunTestFailureDetail(1, "", "")).toBe("exit 1");
  });

  test("isolates hermetic child probes from the production state namespace", () => {
    const env = hermeticSmokeProbeEnv("/tmp/factory-smoke-state", {
      FACTORY_STATE_DIR: "/home/workspace/.runtime/factory-state/v1",
      FACTORY_STATE_MODE: "production",
      FACTORY_PERSONA_ROUTING_MODE: "shadow",
    });
    expect(env.FACTORY_STATE_DIR).toBe("/tmp/factory-smoke-state");
    expect(env.FACTORY_STATE_MODE).toBe("test");
    expect(env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT).toBe("1");
    expect(env.FACTORY_PERSONA_ROUTING_MODE).toBe("shadow");
  });
});
