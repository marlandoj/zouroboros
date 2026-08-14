import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readAuditRecords,
  verifyLedger,
  type AuditRecord,
  type VerifyReport,
} from "../../zouroboros-governance/scripts/governance-ledger";

export interface PromptMetricEvent {
  schema_version: 1;
  observed_at: string;
  source: string;
  cohort_id: string;
  workload_id: string;
  workload_hash: string;
  phase: "before" | "after";
  confirmation_prompts: number;
  action_count: number;
  policy_version: string;
}

export interface PromptMetricSummary {
  status: "ready" | "missing" | "invalid" | "insufficient";
  source_path: string;
  source: string | null;
  matched_workloads: number;
  unmatched_before: number;
  unmatched_after: number;
  invalid_pairs: number;
  before_prompts: number;
  after_prompts: number;
  prompt_reduction: number | null;
  action_count: number;
  error?: string;
}

interface AdapterRecord {
  id: string;
  runtime: string;
  supported: boolean;
  modes?: string[];
  entrypoint?: string;
  evidence?: string;
  reason?: string;
}

interface AdapterInventory {
  schema_version: 1;
  generated_at: string;
  adapters: AdapterRecord[];
}

export interface GovernanceAction {
  ts: string;
  action: string;
  resource: string;
  runtime: string;
  adapter: string;
  mode: string;
  authorization: string;
}

export interface GraphEvidence {
  status: "ready" | "unavailable" | "invalid" | "empty";
  query_script: string;
  db_path: string | null;
  query: string;
  row_count: number;
  result_sha256: string | null;
  error?: string;
}

export interface GovernanceEvidence {
  status: "accepted" | "rejected";
  ledger: VerifyReport;
  source_records: number;
  t0_by_class: Record<string, number>;
  t1_actions: GovernanceAction[];
  t2_denials: GovernanceAction[];
  anomalies: string[];
  unsupported_calls: GovernanceAction[];
  approval_failures: {
    reuse: number;
    revocation: number;
    other: number;
  };
  unapproved_t2_executions: number;
  adapters: AdapterInventory;
  prompts: PromptMetricSummary;
  graph: GraphEvidence;
}

export interface GovernanceEvidenceOptions {
  since: number;
  dataDir: string;
  promptMetricsPath?: string;
  adapterInventoryPath?: string;
  graphQueryScript?: string;
  graphDbPath?: string;
  skipGraph?: boolean;
}

const DEFAULT_ADAPTER_INVENTORY = resolve(
  import.meta.dir,
  "../../zouroboros-governance/config/runtime-adapters.json",
);
const DEFAULT_GRAPH_QUERY = "/home/workspace/Skills/graphrag-relational/scripts/query.ts";
const GRAPH_QUERY =
  "MATCH (e:Execution)-[:GATED_BY]->(g:GateDecision) "
  + "RETURN e.id AS execution_id, g.payload AS gate LIMIT 5";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function loadAdapterInventory(path: string): AdapterInventory {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AdapterInventory>;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.adapters)) {
    throw new Error(`Invalid runtime adapter inventory: ${path}`);
  }
  const ids = new Set<string>();
  const runtimes = new Set<string>();
  for (const adapter of parsed.adapters) {
    if (
      !adapter
      || typeof adapter.id !== "string"
      || typeof adapter.runtime !== "string"
      || typeof adapter.supported !== "boolean"
      || ids.has(adapter.id)
      || runtimes.has(adapter.runtime)
    ) throw new Error(`Invalid or duplicate adapter entry in ${path}`);
    if (adapter.supported && (!adapter.entrypoint || !adapter.evidence)) {
      throw new Error(`Supported adapter ${adapter.id} lacks entrypoint/test evidence`);
    }
    ids.add(adapter.id);
    runtimes.add(adapter.runtime);
  }
  return parsed as AdapterInventory;
}

function parsePromptEvent(value: unknown, line: number): PromptMetricEvent {
  const event = objectValue(value);
  if (!event) throw new Error(`Prompt metric line ${line} is not an object`);
  const valid =
    event.schema_version === 1
    && typeof event.observed_at === "string"
    && Number.isFinite(Date.parse(event.observed_at))
    && typeof event.source === "string"
    && event.source.trim() !== ""
    && typeof event.cohort_id === "string"
    && event.cohort_id.trim() !== ""
    && typeof event.workload_id === "string"
    && event.workload_id.trim() !== ""
    && typeof event.workload_hash === "string"
    && /^[a-f0-9]{64}$/i.test(event.workload_hash)
    && (event.phase === "before" || event.phase === "after")
    && Number.isInteger(event.confirmation_prompts)
    && Number(event.confirmation_prompts) >= 0
    && Number.isInteger(event.action_count)
    && Number(event.action_count) > 0
    && typeof event.policy_version === "string"
    && event.policy_version.trim() !== "";
  if (!valid) throw new Error(`Prompt metric line ${line} violates schema version 1`);
  return event as unknown as PromptMetricEvent;
}

export function summarizePromptMetrics(path: string, since: number): PromptMetricSummary {
  const empty = {
    source_path: path,
    source: null,
    matched_workloads: 0,
    unmatched_before: 0,
    unmatched_after: 0,
    invalid_pairs: 0,
    before_prompts: 0,
    after_prompts: 0,
    prompt_reduction: null,
    action_count: 0,
  };
  if (!existsSync(path)) return { status: "missing", ...empty };
  try {
    const contents = readFileSync(path, "utf8").trim();
    if (!contents) return { status: "insufficient", ...empty };
    const events = contents
      .split("\n")
      .map((line, index) => parsePromptEvent(JSON.parse(line), index + 1))
      .filter((event) => Date.parse(event.observed_at) >= since);
    const sources = new Set(events.map((event) => event.source));
    if (sources.size > 1) throw new Error("Prompt metric window mixes production sources");

    const groups = new Map<string, { before: PromptMetricEvent[]; after: PromptMetricEvent[] }>();
    for (const event of events) {
      const key = `${event.cohort_id}\u0000${event.workload_id}`;
      const group = groups.get(key) ?? { before: [], after: [] };
      group[event.phase].push(event);
      groups.set(key, group);
    }

    let matchedWorkloads = 0;
    let unmatchedBefore = 0;
    let unmatchedAfter = 0;
    let invalidPairs = 0;
    let beforePrompts = 0;
    let afterPrompts = 0;
    let actionCount = 0;
    for (const group of groups.values()) {
      if (group.before.length === 0) {
        unmatchedAfter += group.after.length;
        continue;
      }
      if (group.after.length === 0) {
        unmatchedBefore += group.before.length;
        continue;
      }
      if (group.before.length !== 1 || group.after.length !== 1) {
        invalidPairs += 1;
        continue;
      }
      const before = group.before[0]!;
      const after = group.after[0]!;
      if (before.workload_hash !== after.workload_hash || before.action_count !== after.action_count) {
        invalidPairs += 1;
        continue;
      }
      matchedWorkloads += 1;
      beforePrompts += before.confirmation_prompts;
      afterPrompts += after.confirmation_prompts;
      actionCount += before.action_count;
    }
    const status = matchedWorkloads > 0 ? "ready" : "insufficient";
    return {
      status,
      source_path: path,
      source: [...sources][0] ?? null,
      matched_workloads: matchedWorkloads,
      unmatched_before: unmatchedBefore,
      unmatched_after: unmatchedAfter,
      invalid_pairs: invalidPairs,
      before_prompts: beforePrompts,
      after_prompts: afterPrompts,
      prompt_reduction: matchedWorkloads > 0 && beforePrompts > 0
        ? Number(((beforePrompts - afterPrompts) / beforePrompts).toFixed(4))
        : null,
      action_count: actionCount,
    };
  } catch (error) {
    return {
      status: "invalid",
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function actionFromPayload(record: AuditRecord, payload: Record<string, unknown>): GovernanceAction {
  const classificationInput = objectValue(payload.classification_input);
  const classification = objectValue(payload.classification);
  const authorization = objectValue(payload.authorization);
  return {
    ts: record.ts,
    action: textValue(classificationInput?.action, "unknown"),
    resource: textValue(classificationInput?.resource, "unknown"),
    runtime: textValue(classificationInput?.runtime, "unknown"),
    adapter: textValue(payload.adapter, "unknown"),
    mode: textValue(payload.mode, "unknown"),
    authorization: authorization
      ? `${String(authorization.valid)}:${textValue(authorization.reason, "unspecified")}`
      : "none",
  };
}

export function runGraphEvidence(
  queryScript: string,
  dbPath?: string,
): GraphEvidence {
  const base: GraphEvidence = {
    status: "unavailable",
    query_script: queryScript,
    db_path: dbPath ? resolve(dbPath) : null,
    query: GRAPH_QUERY,
    row_count: 0,
    result_sha256: null,
  };
  if (!existsSync(queryScript)) return { ...base, error: "graph query entrypoint is missing" };
  if (!dbPath || !existsSync(dbPath)) return { ...base, error: "embedded graph data is missing" };
  const result = spawnSync(process.execPath, [
    queryScript,
    "--cypher",
    GRAPH_QUERY,
    "--db",
    resolve(dbPath),
    "--limit",
    "5",
  ], {
    cwd: dirname(queryScript),
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env },
  });
  if (result.error || result.status !== 0) {
    return {
      ...base,
      error: result.error?.message || result.stderr.trim() || `graph query exited ${result.status}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("graph query did not return a result array");
    if (parsed.length === 0) return { ...base, status: "empty", error: "embedded graph query returned zero rows" };
    return {
      ...base,
      status: "ready",
      row_count: parsed.length,
      result_sha256: sha256(JSON.stringify(parsed)),
    };
  } catch (error) {
    return {
      ...base,
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function collectGovernanceEvidence(options: GovernanceEvidenceOptions): GovernanceEvidence {
  const adapterPath = options.adapterInventoryPath ?? DEFAULT_ADAPTER_INVENTORY;
  const adapters = loadAdapterInventory(adapterPath);
  const promptPath = options.promptMetricsPath ?? join(options.dataDir, "confirmation-prompt-events.jsonl");
  const prompts = summarizePromptMetrics(promptPath, options.since);
  const queryScript = options.graphQueryScript ?? DEFAULT_GRAPH_QUERY;
  const graph = options.skipGraph
    ? {
        status: "unavailable" as const,
        query_script: queryScript,
        db_path: options.graphDbPath ? resolve(options.graphDbPath) : null,
        query: GRAPH_QUERY,
        row_count: 0,
        result_sha256: null,
        error: "graph query explicitly skipped",
      }
    : runGraphEvidence(queryScript, options.graphDbPath);
  const ledger = verifyLedger();
  const rejected: GovernanceEvidence = {
    status: "rejected",
    ledger,
    source_records: 0,
    t0_by_class: {},
    t1_actions: [],
    t2_denials: [],
    anomalies: [ledger.anchor_error || "governance ledger integrity failed"],
    unsupported_calls: [],
    approval_failures: { reuse: 0, revocation: 0, other: 0 },
    unapproved_t2_executions: 0,
    adapters,
    prompts,
    graph,
  };
  if (!ledger.ok) return rejected;

  const supportedRuntimes = new Set(adapters.adapters.filter((item) => item.supported).map((item) => item.runtime));
  const records = readAuditRecords().filter((record) => Date.parse(record.ts) >= options.since);
  const t0ByClass: Record<string, number> = {};
  const t1Actions: GovernanceAction[] = [];
  const t2Denials: GovernanceAction[] = [];
  const anomalies: string[] = [];
  const unsupportedCalls: GovernanceAction[] = [];
  const approvalFailures = { reuse: 0, revocation: 0, other: 0 };
  let unapprovedT2Executions = 0;

  for (const record of records) {
    if (record.kind !== "autonomy-decision") continue;
    const payload = objectValue(record.payload);
    const classification = objectValue(payload?.classification);
    if (!payload || !classification) {
      anomalies.push(`${record.ts}: malformed autonomy-decision payload`);
      continue;
    }
    const action = actionFromPayload(record, payload);
    const tier = textValue(classification.tier, "unknown");
    const permissionDecision = textValue(payload.permission_decision, "unknown");
    const authorization = objectValue(payload.authorization);
    const authorizationValid = authorization?.valid === true;
    if (tier === "T0") t0ByClass[action.action] = (t0ByClass[action.action] ?? 0) + 1;
    else if (tier === "T1") t1Actions.push(action);
    else if (tier === "T2") {
      if (payload.would_deny === true || permissionDecision === "deny") t2Denials.push(action);
      if (permissionDecision === "allow" && !authorizationValid) unapprovedT2Executions += 1;
    } else anomalies.push(`${record.ts}: unsupported tier ${tier}`);

    if (!supportedRuntimes.has(action.runtime)) unsupportedCalls.push(action);
    if (classification.policy_version === "unavailable") {
      anomalies.push(`${record.ts}: classifier policy unavailable`);
    }
    if (authorization && authorization.valid === false) {
      const reason = textValue(authorization.reason, "unknown").toLowerCase();
      if (reason.includes("consum") || reason.includes("replay") || reason.includes("used")) approvalFailures.reuse += 1;
      else if (reason.includes("revok")) approvalFailures.revocation += 1;
      else approvalFailures.other += 1;
    }
  }

  return {
    status: "accepted",
    ledger,
    source_records: records.length,
    t0_by_class: t0ByClass,
    t1_actions: t1Actions,
    t2_denials: t2Denials,
    anomalies,
    unsupported_calls: unsupportedCalls,
    approval_failures: approvalFailures,
    unapproved_t2_executions: unapprovedT2Executions,
    adapters,
    prompts,
    graph,
  };
}
