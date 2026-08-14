import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditRecord } from "../../zouroboros-governance/scripts/governance-ledger";
import {
  collectGovernanceEvidence,
  runGraphEvidence,
  summarizePromptMetrics,
  type PromptMetricEvent,
} from "./governance-evidence";

const ENV_KEYS = [
  "ZOUROBOROS_GOVERNANCE_LOG_PATH",
  "ZOUROBOROS_GOVERNANCE_ANCHOR_PATH",
  "ZOUROBOROS_GOVERNANCE_ANCHOR_KEY_PATH",
] as const;

let root = "";
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let adapterInventory = "";

function promptEvent(overrides: Partial<PromptMetricEvent>): PromptMetricEvent {
  return {
    schema_version: 1,
    observed_at: "2026-08-11T12:00:00.000Z",
    source: "zo-permission-ui",
    cohort_id: "cohort-a",
    workload_id: "workload-a",
    workload_hash: "a".repeat(64),
    phase: "before",
    confirmation_prompts: 1,
    action_count: 1,
    policy_version: "legacy-v1",
    ...overrides,
  };
}

function appendDecision(input: {
  tier: string;
  action: string;
  runtime?: string;
  decision?: string;
  wouldDeny?: boolean;
  authorization?: Record<string, unknown> | null;
}): void {
  appendAuditRecord("autonomy-decision", {
    adapter: "claude-pretooluse",
    mode: "hermetic-canary",
    permission_decision: input.decision ?? "deny",
    would_deny: input.wouldDeny ?? true,
    classification_input: {
      action: input.action,
      resource: "/home/workspace",
      runtime: input.runtime ?? "claude",
    },
    classification: { tier: input.tier, policy_version: "fixture-v1" },
    authorization: input.authorization ?? null,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "operator-governance-evidence-"));
  savedEnv = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
  process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH = join(root, "audit.log");
  process.env.ZOUROBOROS_GOVERNANCE_ANCHOR_PATH = join(root, "anchor.log");
  process.env.ZOUROBOROS_GOVERNANCE_ANCHOR_KEY_PATH = join(root, "anchor.key");
  adapterInventory = join(root, "adapters.json");
  writeFileSync(adapterInventory, JSON.stringify({
    schema_version: 1,
    generated_at: "2026-08-11T00:00:00.000Z",
    adapters: [
      {
        id: "claude-pretooluse",
        runtime: "claude",
        supported: true,
        modes: ["hermetic-canary"],
        entrypoint: "adapter.ts",
        evidence: "adapter.test.ts",
      },
      { id: "codex-pretooluse", runtime: "codex", supported: false, reason: "not deployed" },
      { id: "unknown-pretooluse", runtime: "unknown", supported: false, reason: "fail closed" },
    ],
  }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("matched confirmation prompt metrics", () => {
  test("counts only exact before/after workload pairs", () => {
    const path = join(root, "prompts.jsonl");
    const events = [
      promptEvent({ workload_id: "matched", phase: "before", confirmation_prompts: 3, action_count: 3 }),
      promptEvent({ workload_id: "matched", phase: "after", confirmation_prompts: 1, action_count: 3, policy_version: "narrow-v2" }),
      promptEvent({ workload_id: "before-only", phase: "before" }),
      promptEvent({ workload_id: "after-only", phase: "after", policy_version: "narrow-v2" }),
      promptEvent({ workload_id: "hash-drift", phase: "before" }),
      promptEvent({ workload_id: "hash-drift", phase: "after", workload_hash: "b".repeat(64), policy_version: "narrow-v2" }),
    ];
    writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const summary = summarizePromptMetrics(path, Date.parse("2026-08-01T00:00:00.000Z"));
    expect(summary.status).toBe("ready");
    expect(summary.matched_workloads).toBe(1);
    expect(summary.unmatched_before).toBe(1);
    expect(summary.unmatched_after).toBe(1);
    expect(summary.invalid_pairs).toBe(1);
    expect(summary.before_prompts).toBe(3);
    expect(summary.after_prompts).toBe(1);
    expect(summary.prompt_reduction).toBe(0.6667);
  });

  test("does not call a one-sided cohort matched", () => {
    const path = join(root, "one-sided.jsonl");
    writeFileSync(path, `${JSON.stringify(promptEvent({ phase: "before" }))}\n`);
    const summary = summarizePromptMetrics(path, 0);
    expect(summary.status).toBe("insufficient");
    expect(summary.matched_workloads).toBe(0);
    expect(summary.unmatched_before).toBe(1);
  });
});

describe("canonical governance evidence", () => {
  test("rejects a broken anchored ledger before counting records", () => {
    appendDecision({ tier: "T0", action: "workspace.read", decision: "allow", wouldDeny: false });
    const auditPath = process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH!;
    writeFileSync(auditPath, readFileSync(auditPath, "utf8").replace("workspace.read", "workspace.write"));
    const evidence = collectGovernanceEvidence({
      since: 0,
      dataDir: root,
      adapterInventoryPath: adapterInventory,
      skipGraph: true,
    });
    expect(evidence.status).toBe("rejected");
    expect(evidence.source_records).toBe(0);
    expect(evidence.t0_by_class).toEqual({});
  });

  test("itemizes tiers, unsupported calls, approval failures, and unsafe T2 allows", () => {
    appendDecision({ tier: "T0", action: "workspace.read", decision: "allow", wouldDeny: false });
    appendDecision({ tier: "T1", action: "workspace.edit", runtime: "codex" });
    appendDecision({ tier: "T2", action: "github.merge", authorization: { valid: false, reason: "already consumed" } });
    appendDecision({ tier: "T2", action: "service.deploy", decision: "allow", wouldDeny: false, authorization: { valid: false, reason: "revoked" } });
    const evidence = collectGovernanceEvidence({
      since: 0,
      dataDir: root,
      adapterInventoryPath: adapterInventory,
      skipGraph: true,
    });
    expect(evidence.status).toBe("accepted");
    expect(evidence.t0_by_class).toEqual({ "workspace.read": 1 });
    expect(evidence.t1_actions).toHaveLength(1);
    expect(evidence.t2_denials).toHaveLength(1);
    expect(evidence.unsupported_calls).toHaveLength(1);
    expect(evidence.approval_failures).toEqual({ reuse: 1, revocation: 1, other: 0 });
    expect(evidence.unapproved_t2_executions).toBe(1);
  });
});

test("graph evidence is visible when unavailable and bounded when ready", () => {
  const missing = runGraphEvidence(join(root, "missing.ts"), join(root, "db"));
  expect(missing.status).toBe("unavailable");
  mkdirSync(join(root, "db"));
  const script = join(root, "query.ts");
  writeFileSync(script, "console.log(JSON.stringify([{ content: 'fixture', score: 1 }]));\n");
  const ready = runGraphEvidence(script, join(root, "db"));
  expect(ready.status).toBe("ready");
  expect(ready.row_count).toBe(1);
  expect(ready.result_sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("operator digest CLI emits accepted governance evidence end to end", async () => {
  appendDecision({ tier: "T0", action: "workspace.read", decision: "allow", wouldDeny: false });
  const prompts = join(root, "prompts.jsonl");
  writeFileSync(prompts, [
    promptEvent({ phase: "before", confirmation_prompts: 2, action_count: 2 }),
    promptEvent({ phase: "after", confirmation_prompts: 1, action_count: 2, policy_version: "narrow-v2" }),
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const graphDb = join(root, "graph-db");
  mkdirSync(graphDb);
  const graphScript = join(root, "query.ts");
  writeFileSync(graphScript, "console.log(JSON.stringify([{ content: 'bounded', score: 1 }]));\n");
  const healerState = join(root, "healer-state.json");
  writeFileSync(healerState, JSON.stringify({ switches: [], lastProbe: {} }));
  const out = join(root, "digest-out");
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "digest.ts"),
    "--since",
    "2026-08-01T00:00:00.000Z",
    "--data-dir",
    root,
    "--healer-state",
    healerState,
    "--out",
    out,
    "--prompt-metrics",
    prompts,
    "--adapter-inventory",
    adapterInventory,
    "--graph-query-script",
    graphScript,
    "--graph-db",
    graphDb,
    "--no-pdf",
  ], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const manifest = JSON.parse(stdout) as {
    status: string;
    mdPath: string;
    governance: { status: string; prompts: { matched_workloads: number }; graph: { status: string } };
  };
  expect(manifest.status).toBe("clear");
  expect(manifest.governance.status).toBe("accepted");
  expect(manifest.governance.prompts.matched_workloads).toBe(1);
  expect(manifest.governance.graph.status).toBe("ready");
  expect(readFileSync(manifest.mdPath, "utf8")).toContain("## Governance evidence");
});
