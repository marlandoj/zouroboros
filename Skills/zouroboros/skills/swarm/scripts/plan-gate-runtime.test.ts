import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runOperationalPlanGatePreflight,
  SHARED_PLAN_GATE_MODULE,
} from "./plan-gate-runtime.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "operational-plan-gate-"));
  tempDirs.push(dir);
  return dir;
}

test("loads the canonical package implementation", () => {
  expect(SHARED_PLAN_GATE_MODULE.endsWith("/packages/swarm/src/plan-gate-preflight.ts")).toBe(true);
  expect(existsSync(SHARED_PLAN_GATE_MODULE)).toBe(true);
});

test("invalid operational modes hold before execution", async () => {
  const decision = await runOperationalPlanGatePreflight({ mode: "production" });
  expect(decision.action).toBe("hold");
  expect(decision.reason).toBe("invalid_plan_gate_mode");
});

test("shadow mode appends an auditable would-hold record", async () => {
  const dir = tempDir();
  const planPath = join(dir, "plan.yaml");
  const ledgerPath = join(dir, "shadow-audit.jsonl");
  writeFileSync(planPath, [
    "id: operational-shadow-smoke",
    "title: Operational shadow smoke",
    "risk: high",
    "revision: 1",
    "tasks:",
    "  - id: T1",
    "    title: Verify operational reachability",
    "    depends_on: []",
    "acceptance_criteria:",
    "  - The operational runtime records the decision.",
    "exit_conditions:",
    "  - name: verified",
    "    criteria: The shadow ledger contains one valid record.",
    "rollback: Set PLAN_GATE_MODE to disabled.",
    "",
  ].join("\n"));

  const decision = await runOperationalPlanGatePreflight({
    mode: "shadow",
    planPath,
    ledgerPath,
    workspaceRoot: "/home/workspace",
  });

  expect(decision.action).toBe("proceed");
  expect(decision.wouldHold).toBe(true);
  expect(decision.auditEvent).toBe("plan_gate_shadow_hold");
  const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
  expect(records).toHaveLength(1);
  expect(records[0].execution_action).toBe("proceed");
  expect(records[0].would_hold).toBe(true);
  expect(records[0].artifact_sha256).not.toBe("0".repeat(64));
});

test("operational CLI records shadow evidence before invalid campaign rejection", () => {
  const dir = tempDir();
  const planPath = join(dir, "plan.yaml");
  const campaignPath = join(dir, "campaign.json");
  const ledgerPath = join(dir, "shadow-audit.jsonl");
  writeFileSync(planPath, [
    "id: operational-cli-shadow",
    "title: Operational CLI shadow",
    "risk: high",
    "revision: 1",
    "tasks:",
    "  - id: T1",
    "    title: Reject invalid campaign after plan gate",
    "    depends_on: []",
    "acceptance_criteria:",
    "  - Shadow evidence is recorded before campaign validation.",
    "exit_conditions:",
    "  - name: recorded",
    "    criteria: The audit record exists and no executor runs.",
    "rollback: Set PLAN_GATE_MODE to disabled.",
    "",
  ].join("\n"));
  writeFileSync(campaignPath, JSON.stringify([{
    persona: "auto",
    task: "This campaign intentionally omits its task ID.",
    priority: "low",
  }]));

  const result = Bun.spawnSync({
    cmd: [
      "bun",
      join(import.meta.dir, "orchestrate-v5.ts"),
      campaignPath,
      "--swarm-id",
      `operational-shadow-smoke-${process.pid}-${Date.now()}`,
      "--plan-gate-mode",
      "shadow",
      "--plan-gate-plan",
      planPath,
      "--plan-gate-ledger",
      ledgerPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });

  const stdout = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("[PLAN GATE:shadow] PROCEED - shadow_or_advisory_would_hold");
  expect(stdout).toContain("Pre-flight failed");
  const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
  expect(records).toHaveLength(1);
  expect(records[0].audit_event).toBe("plan_gate_shadow_hold");
}, 30_000);

describe("operational source ordering", () => {
  test("runs the shared plan gate before task validation and routing", () => {
    const source = readFileSync(join(import.meta.dir, "orchestrate-v5.ts"), "utf8");
    const preflight = source.slice(
      source.indexOf("private async preflight"),
      source.indexOf("// MAIN EXECUTION"),
    );
    expect(preflight.indexOf("runOperationalPlanGatePreflight(this.config.planGate)"))
      .toBeGreaterThan(-1);
    expect(preflight.indexOf("runOperationalPlanGatePreflight(this.config.planGate)"))
      .toBeLessThan(preflight.indexOf("getEffectiveExecutor(task)"));
  });

  test("hybrid execution forwards plan-gate arguments to the operational CLI", () => {
    const source = readFileSync(join(import.meta.dir, "swarm-hybrid-runner.ts"), "utf8");
    expect(source).toContain("const extraArgs = [...args.slice(1)]");
    expect(source).toContain("...extraArgs");
  });
});
