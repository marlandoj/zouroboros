import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDirs: string[] = [];
const tempFiles: string[] = [];
const scriptPath = join(import.meta.dir, "swarm-exec.ts");

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  while (tempFiles.length) rmSync(tempFiles.pop()!, { force: true });
});

function runDryExecution(phase: unknown, writeState = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-shadow-phase-"));
  tempDirs.push(stateDir);
  const dispatchPath = join(stateDir, "dispatch.json");
  if (writeState) {
    writeFileSync(join(stateDir, "shadow-state.json"), JSON.stringify({
      current_phase: phase,
      phase_started_at: "2026-08-10T00:00:00.000Z",
      dry_run_started_at: "2026-08-01T00:00:00.000Z",
      shadow_pr_started_at: "2026-08-03T00:00:00.000Z",
      live_started_at: "2026-08-07T00:00:00.000Z",
      transitions: [],
      safe_executions: 23,
      unsafe_auto_executions: 0,
    }));
  }
  writeFileSync(dispatchPath, JSON.stringify([{
    ticket: {
      linear_id: "linear-zou-1185",
      identifier: "ZOU-1185",
      title: "Shadow phase provenance fixture",
      description: "**archetype:** docs",
      url: "https://linear.app/example/ZOU-1185",
      state: "In Progress",
      labels: [],
      created_at: "2026-08-10T00:00:00.000Z",
      updated_at: "2026-08-10T00:00:00.000Z",
    },
    decision: "DIRECT",
    score: 0.1,
    override: false,
    exit_code: 2,
    raw_output: "fixture",
  }]));

  const result = spawnSync("bun", [scriptPath, "--dispatch", dispatchPath, "--dry-run"], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      FACTORY_STATE_DIR: stateDir,
      SF002_CLASSIFY: "0",
      SF003_POOL: "0",
      SF005_SLO: "0",
      SF006_DEDUP: "0",
      SF007_SIGNALS: "0",
      SF008_FLEET: "0",
      SF_HETZNER_EXECUTOR: "0",
      SF_EXEC_ISOLATED_WORKTREE: "0",
      SF_MODEL_POLICY_HOOK: "0",
      FACTORY_CODING_CASCADE: "off",
      FACTORY_PRODUCT_GATE: "0",
      PLAN_GATE_MODE: "disabled",
    },
  });
  const records = readdirSync(stateDir).filter((name) => /^exec-.*\.json$/.test(name));
  return { result, stateDir, records };
}

function runMalformedCachedSeedExecution() {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-cached-seed-failure-"));
  tempDirs.push(stateDir);
  const dispatchPath = join(stateDir, "dispatch.json");
  const seedPath = join(import.meta.dir, "..", "seed-zou-99999.yaml");
  tempFiles.push(seedPath);
  writeFileSync(join(stateDir, "shadow-state.json"), JSON.stringify({
    current_phase: "live",
    phase_started_at: "2026-08-10T00:00:00.000Z",
    dry_run_started_at: "2026-08-01T00:00:00.000Z",
    shadow_pr_started_at: "2026-08-03T00:00:00.000Z",
    live_started_at: "2026-08-07T00:00:00.000Z",
    transitions: [],
    safe_executions: 23,
    unsafe_auto_executions: 0,
  }));
  writeFileSync(seedPath, "id: ZOU-99999\ntasks:\n  - id: T1\n    deps: []\n");
  writeFileSync(dispatchPath, JSON.stringify([{
    ticket: {
      linear_id: "linear-zou-99999",
      identifier: "ZOU-99999",
      title: "Malformed cached seed fixture",
      description: "**archetype:** code",
      url: "https://linear.app/example/ZOU-99999",
      state: "Todo",
      labels: ["factory-ready"],
      created_at: "2026-08-10T00:00:00.000Z",
      updated_at: "2026-08-10T00:00:00.000Z",
    },
    decision: "FORCE_SWARM",
    score: 1,
    override: true,
    exit_code: 0,
    raw_output: "fixture",
  }]));

  const result = spawnSync("bun", [scriptPath, "--dispatch", dispatchPath], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      FACTORY_STATE_DIR: stateDir,
      SF002_CLASSIFY: "0",
      SF003_POOL: "1",
      SF003_POOL_MODE: "plan",
      SF005_SLO: "0",
      SF006_DEDUP: "0",
      SF007_SIGNALS: "0",
      SF008_FLEET: "0",
      SF_HETZNER_EXECUTOR: "0",
      SF_EXEC_ISOLATED_WORKTREE: "0",
      SF_MODEL_POLICY_HOOK: "0",
      SF_FACTORY_CONSENSUS: "0",
      SF_EVIDENCE_MODE: "advisory",
      FACTORY_CODING_CASCADE: "off",
      FACTORY_PRODUCT_GATE: "0",
      PLAN_GATE_MODE: "disabled",
    },
  });
  const records = readdirSync(stateDir).filter((name) => /^exec-.*\.json$/.test(name));
  return { result, stateDir, records };
}

describe("ZOU-1185 execution shadow-phase provenance", () => {
  test("all execution-record creation paths use the authoritative phase reader", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source.match(/shadow_phase:\s*currentShadowPhase\(\)/g)).toHaveLength(10);
    expect(source).not.toMatch(/shadow_phase:\s*(?:"dry-run"|"blocking"|planGate\.mode)/);
    expect(source).toContain("shadow_phase: exec.shadow_phase");
  });

  test.each(["idle", "dry-run", "shadow-pr", "live"])(
    "a new direct record is stamped with the current %s phase",
    (phase) => {
      const { result, stateDir, records } = runDryExecution(phase);
      expect(result.status, result.stderr).toBe(0);
      expect(records).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(stateDir, records[0]), "utf8"));
      expect(record.shadow_phase).toBe(phase);
    },
  );

  test("an invalid persisted phase fails closed before an execution record is written", () => {
    const { result, records } = runDryExecution("production-ish");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid shadow phase");
    expect(records).toHaveLength(0);
  });

  test("missing shadow state fails closed instead of fabricating an idle stamp", () => {
    const { result, records } = runDryExecution(undefined, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Shadow state unavailable");
    expect(records).toHaveLength(0);
  });

  test("a malformed cached seed writes a durable retryable failure record", () => {
    const { result, stateDir, records } = runMalformedCachedSeedExecution();
    expect(result.status, result.stderr).toBe(0);
    expect(records).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(stateDir, records[0]), "utf8"));
    expect(record.state).toBe("failed");
    expect(record.status).toBe("failed");
    expect(record.stage).toBe("failed");
    expect(record.retry_eligible).toBe(true);
    expect(record.error).toContain("missing name");
    expect(record.evidence.failed).toContainEqual(expect.objectContaining({ kind: "execution-exception" }));
    expect(result.stderr).toContain("failed before durable executor result");
  });
});
