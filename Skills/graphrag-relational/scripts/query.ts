#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Graph } from "falkordblite";
import { writeRagTelemetry } from "../../rag-telemetry/scripts/telemetry.ts";
import { DEFAULT_FACTORY_DIR, type JsonValue } from "./extract.ts";
import { openEmbeddedGraph } from "./runtime.ts";

export interface RagSearchResult {
  content: string;
  score: number;
  metadata: Record<string, JsonValue>;
}

export interface QueryOptions {
  dbPath: string;
  question: string;
  limit: number;
  cypher?: string;
  redisServerPath?: string;
  modulePath?: string;
}

type QueryTemplate = "co_failed_modules" | "gate_by_module" | "cost_breakdown" | "related_tasks" | "custom_cypher";

interface QueryPlan {
  template: QueryTemplate;
  cypher: string;
  question: string;
  limit: number;
}

type GraphValue = null | string | number | boolean | Date | bigint | GraphValue[] | { [key: string]: GraphValue };
type Row = Record<string, GraphValue>;

const DEFAULT_DB_PATH = join(DEFAULT_FACTORY_DIR, "state", "graphrag-relational", "falkordblite");
const WRITE_CLAUSES = new Set([
  "create",
  "merge",
  "set",
  "remove",
  "delete",
  "detach",
  "drop",
  "copy",
  "load",
  "import",
  "export",
  "alter",
  "comment",
  "install",
  "call",
  "attach",
  "checkpoint",
]);

const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "area",
  "breakdown",
  "cost",
  "did",
  "for",
  "given",
  "module",
  "modules",
  "of",
  "related",
  "say",
  "tasks",
  "the",
  "this",
  "to",
  "touching",
  "was",
  "what",
  "with",
]);

interface CliOptions extends QueryOptions {
  pretty: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: DEFAULT_DB_PATH,
    question: "",
    limit: 8,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--question" && next) {
      options.question = next;
      index++;
    } else if (arg === "--db" && next) {
      options.dbPath = resolve(next);
      index++;
    } else if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        throw new Error("--limit must be an integer from 1 to 50");
      }
      options.limit = parsed;
      index++;
    } else if (arg === "--cypher" && next) {
      options.cypher = next;
      index++;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!options.question && !options.cypher) throw new Error("--question is required unless --cypher is provided");
  if (!options.question) options.question = "custom Cypher query";
  options.dbPath = resolve(options.dbPath);
  return options;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/query.ts --question "tasks related to module X" [options]

Options:
  --question <text>  Natural-language graph question to answer
  --cypher <query>   Read-only Cypher override; rejected if it contains write/schema clauses
  --db <path>        Embedded FalkorDB data directory (default: ${DEFAULT_DB_PATH})
  --limit <n>        Max context blobs to emit, 1-50 (default: 8)
  --pretty           Pretty-print JSON output
`);
}

function templateForQuestion(question: string, hasCypher: boolean): QueryTemplate {
  if (hasCypher) return "custom_cypher";
  const lower = question.toLowerCase();
  if (lower.includes("cost")) return "cost_breakdown";
  if (lower.includes("gate") || lower.includes("gated")) return "gate_by_module";
  if (lower.includes("co-failed") || lower.includes("co failed") || lower.includes("failed with")) {
    return "co_failed_modules";
  }
  return "related_tasks";
}

function planQuery(options: QueryOptions): QueryPlan {
  const template = templateForQuestion(options.question, Boolean(options.cypher));
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), 50);
  const cypher =
    options.cypher ??
    {
      co_failed_modules:
        "MATCH (e:Execution)-[:GATED_BY]->(g:GateDecision), (e)-[:HAS_RECORD]->(r:FactoryRecord) " +
        `RETURN e.id AS execution_id, e.payload AS execution, g.payload AS gate, r.payload AS record LIMIT ${limit * 8}`,
      gate_by_module:
        "MATCH (e:Execution)-[:IMPLEMENTS]->(t:Ticket), (e)-[:GATED_BY]->(g:GateDecision) " +
        `RETURN e.id AS execution_id, e.payload AS execution, t.id AS ticket_id, t.payload AS ticket, g.payload AS gate LIMIT ${limit * 8}`,
      cost_breakdown:
        "MATCH (e:Execution)-[:INCURRED_COST]->(c:CostEntry) " +
        `RETURN e.id AS execution_id, e.payload AS execution, c.id AS cost_id, c.payload AS cost LIMIT ${limit * 8}`,
      related_tasks:
        "MATCH (e:Execution)-[:IMPLEMENTS]->(t:Ticket) " +
        `RETURN e.id AS execution_id, e.payload AS execution, t.id AS ticket_id, t.payload AS ticket LIMIT ${limit * 8}`,
      custom_cypher: "",
    }[template];

  assertReadOnlyCypher(cypher);
  return { template, cypher, question: options.question, limit };
}

export function assertReadOnlyCypher(cypher: string): void {
  const statements = cypher
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (statements.length !== 1) throw new Error("Only one read-only Cypher statement is allowed");

  const tokens = statements[0]
    .replace(/\/\/.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!tokens?.length) throw new Error("Cypher query is empty");
  const first = tokens[0].toLowerCase();
  if (first !== "match" && first !== "optional" && first !== "with" && first !== "unwind") {
    throw new Error(`Read-only Cypher must start with MATCH/WITH/UNWIND, got ${tokens[0]}`);
  }
  for (const token of tokens) {
    if (WRITE_CLAUSES.has(token.toLowerCase())) throw new Error(`Write/schema Cypher clause rejected: ${token}`);
  }
}

async function runCypher(graph: Graph, cypher: string): Promise<Row[]> {
  assertReadOnlyCypher(cypher);
  const result = await graph.roQuery<Row>(cypher);
  return result.data ?? [];
}

function parsePayload(value: GraphValue | undefined): Record<string, JsonValue> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

function normalizeValue(value: GraphValue | undefined): JsonValue {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = normalizeValue(nested as GraphValue);
    return out;
  }
  return String(value);
}

function rowToText(row: Row): string {
  return Object.values(row)
    .map((value) => {
      if (typeof value === "string") return value;
      if (value === null || value === undefined) return "";
      return JSON.stringify(normalizeValue(value));
    })
    .join(" ");
}

function terms(question: string): string[] {
  return [...new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].filter(
    (term) => !STOP_WORDS.has(term),
  );
}

function scoreRow(row: Row, plan: QueryPlan): number {
  const haystack = rowToText(row).toLowerCase();
  const wanted = terms(plan.question);
  const matched = wanted.filter((term) => haystack.includes(term)).length;
  const matchScore = wanted.length === 0 ? 0.15 : matched / wanted.length;
  const execution = parsePayload(row.execution);
  const gate = parsePayload(row.gate);
  const status = typeof execution.status === "string" ? execution.status.toLowerCase() : "";
  const gateDecision = typeof gate.decision === "string" ? gate.decision.toLowerCase() : "";
  const templateBoost =
    plan.template === "co_failed_modules"
      ? (status.includes("fail") ? 0.2 : 0) + (gateDecision.includes("swarm") ? 0.08 : 0)
      : plan.template === "cost_breakdown"
        ? 0.12
        : plan.template === "gate_by_module"
          ? 0.1
          : 0.05;
  return Number(Math.min(1, 0.35 + matchScore * 0.47 + templateBoost).toFixed(4));
}

function formatContent(row: Row, plan: QueryPlan): string {
  const execution = parsePayload(row.execution);
  const ticket = parsePayload(row.ticket);
  const gate = parsePayload(row.gate);
  const record = parsePayload(row.record);
  const cost = parsePayload(row.cost);
  const identifier = stringProp(execution.identifier) ?? stringProp(ticket.identifier) ?? String(row.execution_id ?? "execution");
  const branch = stringProp(execution.branch_name);
  const status = stringProp(execution.status) ?? stringProp(execution.stage) ?? "unknown";
  const gateDecision = stringProp(gate.decision);

  if (plan.template === "cost_breakdown") {
    const amount = cost.amount_usd ?? cost.cost_usd ?? cost.total_cost_usd ?? "unknown";
    return `${identifier}: cost ${amount} USD; status ${status}${branch ? `; branch ${branch}` : ""}.`;
  }
  if (plan.template === "gate_by_module") {
    const title = stringProp(ticket.title);
    return `${identifier}: gate ${gateDecision ?? "unknown"} for ${title ?? branch ?? "matched ticket"}; status ${status}.`;
  }
  if (plan.template === "co_failed_modules") {
    const collectedAt = stringProp(record.collected_at);
    return `${identifier}: ${status} execution${gateDecision ? ` gated ${gateDecision}` : ""}${branch ? ` on ${branch}` : ""}${collectedAt ? `; factory record ${collectedAt}` : ""}.`;
  }
  if (plan.template === "custom_cypher") return JSON.stringify(normalizeRow(row));
  const title = stringProp(ticket.title);
  return `${identifier}: ${title ?? branch ?? "matched execution"}; status ${status}${gateDecision ? `; gate ${gateDecision}` : ""}.`;
}

function stringProp(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeRow(row: Row): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
  return out;
}

function resultFromRow(row: Row, plan: QueryPlan): RagSearchResult {
  const execution = parsePayload(row.execution);
  const ticket = parsePayload(row.ticket);
  const gate = parsePayload(row.gate);
  const cost = parsePayload(row.cost);
  const record = parsePayload(row.record);
  return {
    content: formatContent(row, plan),
    score: scoreRow(row, plan),
    metadata: {
      source: "graphrag-relational",
      template: plan.template,
      cypher: plan.cypher,
      execution_id: normalizeValue(row.execution_id ?? null),
      ticket_id: normalizeValue(row.ticket_id ?? null),
      cost_id: normalizeValue(row.cost_id ?? null),
      execution,
      ticket,
      gate,
      cost,
      record,
    },
  };
}

function emptyCostResult(plan: QueryPlan): RagSearchResult {
  return {
    content: "No CostEntry nodes are present in the live graph; cost traversal returned zero rows.",
    score: 0.2,
    metadata: {
      source: "graphrag-relational",
      template: plan.template,
      cypher: plan.cypher,
      empty_result: true,
      reason: "live graph has no CostEntry/INCURRED_COST rows",
    },
  };
}

function templateHops(template: QueryTemplate): number | null {
  if (template === "co_failed_modules" || template === "gate_by_module") return 2;
  if (template === "cost_breakdown" || template === "related_tasks") return 1;
  return null;
}

function emitGraphQueryTelemetry(
  options: QueryOptions,
  plan: QueryPlan | undefined,
  started: number,
  ok: boolean,
  rowCount: number,
  contextCount: number,
  error?: unknown,
): void {
  try {
    writeRagTelemetry({
      method: "graph",
      operation: "query",
      source: "graphrag-relational",
      ok,
      durationMs: performance.now() - started,
      resultCount: contextCount,
      zeroResult: ok && rowCount === 0,
      query: options.question,
      error,
      details: {
        template: plan?.template ?? "unplanned",
        hops: plan ? templateHops(plan.template) : null,
        rows: rowCount,
        contexts: contextCount,
        limit: options.limit,
        customCypher: Boolean(options.cypher),
      },
    });
  } catch (telemetryError) {
    console.error(`[rag-telemetry] graph query event write failed: ${telemetryError instanceof Error ? telemetryError.message : String(telemetryError)}`);
  }
}

export async function queryGraphRag(options: QueryOptions): Promise<RagSearchResult[]> {
  const started = performance.now();
  let plan: QueryPlan | undefined;
  try {
    plan = planQuery(options);
    if (!existsSync(options.dbPath)) throw new Error(`Embedded FalkorDB data not found: ${options.dbPath}`);

    const session = await openEmbeddedGraph({
      path: options.dbPath,
      redisServerPath: options.redisServerPath,
      modulePath: options.modulePath,
    });
    try {
      const rows = await runCypher(session.graph, plan.cypher);
      const results = rows.length === 0 && plan.template === "cost_breakdown"
        ? [emptyCostResult(plan)]
        : rows
          .map((row) => resultFromRow(row, plan!))
          .sort((a, b) => b.score - a.score || a.content.localeCompare(b.content))
          .slice(0, plan.limit);
      emitGraphQueryTelemetry(options, plan, started, true, rows.length, results.length);
      return results;
    } finally {
      await session.close();
    }
  } catch (error) {
    emitGraphQueryTelemetry(options, plan, started, false, 0, 0, error);
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results = await queryGraphRag(options);
  console.log(JSON.stringify(results, null, options.pretty ? 2 : 0));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
