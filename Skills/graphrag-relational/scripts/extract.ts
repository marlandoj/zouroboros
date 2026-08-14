#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Database as SQLiteDatabase } from "bun:sqlite";

export type NodeLabel = "Execution" | "Ticket" | "CostEntry" | "GateDecision" | "FactoryRecord";
export type EdgeType = "IMPLEMENTS" | "INCURRED_COST" | "GATED_BY" | "HAS_RECORD";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: Record<string, JsonValue>;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  from: string;
  to: string;
  properties: Record<string, JsonValue>;
}

export interface PropertyGraph {
  schema: {
    nodes: NodeLabel[];
    edges: EdgeType[];
  };
  counts: {
    nodes: Record<NodeLabel, number>;
    edges: Record<EdgeType, number>;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  sources: {
    swarmDb: DbInspection;
    factoryLogPath: string;
    linearSources: string[];
  };
  warnings: string[];
}

interface DbInspection {
  path: string;
  engine: "sqlite" | "duckdb" | "unknown" | "missing";
  tables: TableInspection[];
  foreignKeys: ForeignKeyInspection[];
  errors: string[];
}

interface TableInspection {
  name: string;
  columns: string[];
}

interface ForeignKeyInspection {
  table: string;
  from: string;
  toTable: string;
  to: string;
  id?: number;
  seq?: number;
}

export interface ExtractOptions {
  swarmDbPath: string;
  factoryLogPath: string;
  stateDir: string;
  linearJsonPaths: string[];
  outPath: string | null;
  pretty: boolean;
}

interface FactoryLogRecord {
  execution_id?: unknown;
  kind?: unknown;
  ticket_id?: unknown;
  identifier?: unknown;
  gate_decision?: unknown;
  shadow_phase?: unknown;
  status?: unknown;
  stages?: unknown;
  verdict_ref?: unknown;
  measured?: unknown;
  verdict?: unknown;
  cycle_time_hours?: unknown;
  collected_at?: unknown;
  [key: string]: unknown;
}

interface ExecutionRecord {
  execution_id?: unknown;
  ticket_id?: unknown;
  identifier?: unknown;
  gate_decision?: unknown;
  status?: unknown;
  stage?: unknown;
  branch_name?: unknown;
  pr_number?: unknown;
  shadow_phase?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  state_updated_at?: unknown;
  result_summary?: unknown;
  error?: unknown;
  evidence?: unknown;
  [key: string]: unknown;
}

interface TicketLike {
  id?: unknown;
  ticket_id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  project_id?: unknown;
  state?: unknown;
  labels?: unknown;
  team?: unknown;
  [key: string]: unknown;
}

class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  upsertNode(label: NodeLabel, key: string, properties: Record<string, JsonValue>): string {
    const id = `${label}:${key}`;
    const prev = this.nodes.get(id);
    this.nodes.set(id, {
      id,
      label,
      properties: prev ? { ...prev.properties, ...properties } : properties,
    });
    return id;
  }

  addEdge(type: EdgeType, from: string, to: string, properties: Record<string, JsonValue> = {}): void {
    const id = `${type}:${from}->${to}`;
    if (!this.edges.has(id)) this.edges.set(id, { id, type, from, to, properties });
  }

  toGraph(sources: PropertyGraph["sources"], warnings: string[]): PropertyGraph {
    const labels: NodeLabel[] = ["Execution", "Ticket", "CostEntry", "GateDecision", "FactoryRecord"];
    const edgeTypes: EdgeType[] = ["IMPLEMENTS", "INCURRED_COST", "GATED_BY", "HAS_RECORD"];
    const nodeCounts = Object.fromEntries(labels.map((label) => [label, 0])) as Record<NodeLabel, number>;
    const edgeCounts = Object.fromEntries(edgeTypes.map((type) => [type, 0])) as Record<EdgeType, number>;

    for (const node of this.nodes.values()) nodeCounts[node.label]++;
    for (const edge of this.edges.values()) edgeCounts[edge.type]++;

    return {
      schema: { nodes: labels, edges: edgeTypes },
      counts: { nodes: nodeCounts, edges: edgeCounts },
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      sources,
      warnings,
    };
  }
}

export const DEFAULT_FACTORY_DIR = "/home/workspace/Projects/zouroboros-software-factory";

function parseArgs(argv: string[]): ExtractOptions {
  const opts: ExtractOptions = {
    swarmDbPath: join(DEFAULT_FACTORY_DIR, "swarm.db"),
    factoryLogPath: join(DEFAULT_FACTORY_DIR, "state", "factory-log.jsonl"),
    stateDir: join(DEFAULT_FACTORY_DIR, "state"),
    linearJsonPaths: [join(DEFAULT_FACTORY_DIR, "state", "intake-ledger.jsonl")],
    outPath: null,
    pretty: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--swarm-db" && next) {
      opts.swarmDbPath = resolve(next);
      i++;
    } else if (arg === "--factory-log" && next) {
      opts.factoryLogPath = resolve(next);
      i++;
    } else if (arg === "--state-dir" && next) {
      opts.stateDir = resolve(next);
      i++;
    } else if (arg === "--linear-json" && next) {
      opts.linearJsonPaths.push(resolve(next));
      i++;
    } else if (arg === "--out" && next) {
      opts.outPath = resolve(next);
      i++;
    } else if (arg === "--pretty") {
      opts.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  opts.swarmDbPath = resolve(opts.swarmDbPath);
  opts.factoryLogPath = resolve(opts.factoryLogPath);
  opts.stateDir = resolve(opts.stateDir);
  opts.linearJsonPaths = [...new Set(opts.linearJsonPaths.map((path) => resolve(path)))];
  return opts;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/extract.ts [options]

Options:
  --swarm-db <path>      Source swarm database (default: ${DEFAULT_FACTORY_DIR}/swarm.db)
  --factory-log <path>   Source factory-log JSONL (default: ${DEFAULT_FACTORY_DIR}/state/factory-log.jsonl)
  --state-dir <path>     Source execution state directory (default: ${DEFAULT_FACTORY_DIR}/state)
  --linear-json <path>   Additional Linear ticket JSON/JSONL source; repeatable
  --out <path>           Write graph JSON to a file instead of stdout
  --pretty               Pretty-print JSON output
`);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = asJson(nested);
    return out;
  }
  return String(value);
}

function flattenJson(prefix: string, value: unknown): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    out[prefix] = asJson(value);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    const prop = `${prefix}_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(out, flattenJson(prop, nested));
    } else {
      out[prop] = asJson(nested);
    }
  }
  return out;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function readJsonl(path: string, warnings: string[]): unknown[] {
  if (!existsSync(path)) return [];
  const rows: unknown[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      warnings.push(`${path}:${index + 1}: skipped malformed JSONL row (${(err as Error).message})`);
    }
  });
  return rows;
}

function readJsonFile(path: string, warnings: string[]): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { issues?: unknown }).issues)) {
      return (parsed as { issues: unknown[] }).issues;
    }
    return [parsed];
  } catch (err) {
    warnings.push(`${path}: skipped malformed JSON (${(err as Error).message})`);
    return [];
  }
}

function detectDbEngine(path: string): DbInspection["engine"] {
  if (!existsSync(path)) return "missing";
  const header = readFileSync(path).subarray(0, 64).toString("utf-8");
  if (header.includes("SQLite format 3")) return "sqlite";
  if (header.includes("DUCK")) return "duckdb";
  return "unknown";
}

function inspectSwarmDb(path: string, warnings: string[]): DbInspection {
  const inspection: DbInspection = {
    path,
    engine: detectDbEngine(path),
    tables: [],
    foreignKeys: [],
    errors: [],
  };

  if (inspection.engine === "missing") {
    inspection.errors.push("database file does not exist");
    return inspection;
  }
  if (inspection.engine === "sqlite") inspectSqliteDb(inspection, warnings);
  if (inspection.engine === "duckdb") inspectDuckDb(inspection, warnings);
  if (inspection.engine === "unknown") inspection.errors.push("unsupported database file header");
  return inspection;
}

function inspectSqliteDb(inspection: DbInspection, warnings: string[]): void {
  try {
    const db = new SQLiteDatabase(inspection.path, { readonly: true });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    for (const { name } of tables) {
      const columns = (db.query(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      inspection.tables.push({ name, columns });
      const fks = db.query(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as Array<{
        id?: number;
        seq?: number;
        table?: string;
        from?: string;
        to?: string;
      }>;
      for (const fk of fks) {
        inspection.foreignKeys.push({
          table: name,
          from: fk.from ?? "",
          toTable: fk.table ?? "",
          to: fk.to ?? "",
          id: fk.id,
          seq: fk.seq,
        });
      }
    }
    db.close();
  } catch (err) {
    inspection.errors.push(`sqlite introspection failed: ${(err as Error).message}`);
    warnings.push(`swarm.db sqlite introspection failed: ${(err as Error).message}`);
  }
}

function inspectDuckDb(inspection: DbInspection, warnings: string[]): void {
  const tablesResult = runDuckDbJson(inspection.path, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name;");
  if (!tablesResult.ok) {
    inspection.errors.push(`duckdb table introspection failed: ${tablesResult.error}`);
    warnings.push(`swarm.db duckdb table introspection failed: ${tablesResult.error}`);
    return;
  }

  const tableNames = tablesResult.rows.map((row) => asString((row as Record<string, unknown>).table_name)).filter((v): v is string => v !== null);
  for (const tableName of tableNames) {
    const pragma = runDuckDbJson(inspection.path, `PRAGMA table_info('${sqlString(tableName)}');`);
    if (!pragma.ok) {
      inspection.errors.push(`duckdb PRAGMA table_info(${tableName}) failed: ${pragma.error}`);
      continue;
    }
    const columns = pragma.rows
      .map((row) => asString((row as Record<string, unknown>).name))
      .filter((v): v is string => v !== null);
    inspection.tables.push({ name: tableName, columns });
  }

  const fkResult = runDuckDbJson(
    inspection.path,
    "SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name " +
      "FROM information_schema.table_constraints tc " +
      "JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name " +
      "JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name " +
      "WHERE tc.constraint_type = 'FOREIGN KEY' ORDER BY tc.table_name, kcu.column_name;",
  );
  if (fkResult.ok) {
    for (const row of fkResult.rows as Array<Record<string, unknown>>) {
      inspection.foreignKeys.push({
        table: asString(row.table_name) ?? "",
        from: asString(row.column_name) ?? "",
        toTable: asString(row.foreign_table_name) ?? "",
        to: asString(row.foreign_column_name) ?? "",
      });
    }
  } else {
    inspection.errors.push(`duckdb foreign-key introspection failed: ${fkResult.error}`);
  }
}

function sqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function runDuckDbJson(dbPath: string, sql: string): { ok: true; rows: unknown[] } | { ok: false; error: string } {
  const proc = Bun.spawnSync({
    cmd: ["duckdb", dbPath, "-json", "-c", sql],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return { ok: false, error: proc.stderr.toString().trim() || `duckdb exited ${proc.exitCode}` };
  const text = proc.stdout.toString().trim();
  if (text === "") return { ok: true, rows: [] };
  try {
    return { ok: true, rows: JSON.parse(text) as unknown[] };
  } catch (err) {
    return { ok: false, error: `invalid duckdb JSON output: ${(err as Error).message}` };
  }
}

function executionProps(rec: FactoryLogRecord | ExecutionRecord): Record<string, JsonValue> {
  const props: Record<string, JsonValue> = {};
  const fields = [
    "execution_id",
    "ticket_id",
    "identifier",
    "status",
    "stage",
    "shadow_phase",
    "branch_name",
    "pr_number",
    "started_at",
    "completed_at",
    "state_updated_at",
    "cycle_time_hours",
  ];
  for (const field of fields) {
    if (field in rec) props[field] = asJson((rec as Record<string, unknown>)[field]);
  }
  if ("stages" in rec) Object.assign(props, flattenJson("stage", parseMaybeJson(rec.stages)));
  if ("verdict" in rec) Object.assign(props, flattenJson("verdict", parseMaybeJson(rec.verdict)));
  return props;
}

function ingestFactoryLog(path: string, graph: GraphBuilder, warnings: string[]): void {
  const rows = readJsonl(path, warnings) as FactoryLogRecord[];
  for (const [index, row] of rows.entries()) {
    const executionId = asString(row.execution_id);
    if (!executionId) {
      warnings.push(`${path}:${index + 1}: skipped factory row without execution_id`);
      continue;
    }

    const factoryRecordId = graph.upsertNode("FactoryRecord", executionId, {
      source: "factory-log",
      source_line: index + 1,
      kind: asJson(row.kind),
      collected_at: asJson(row.collected_at),
      measured: asJson(row.measured),
      verdict_ref: asJson(row.verdict_ref),
      ...flattenJson("stages", parseMaybeJson(row.stages)),
      ...flattenJson("verdict", parseMaybeJson(row.verdict)),
    });

    const executionNodeId = graph.upsertNode("Execution", executionId, {
      source: "factory-log",
      ...executionProps(row),
    });
    graph.addEdge("HAS_RECORD", executionNodeId, factoryRecordId);

    const ticketId = asString(row.ticket_id);
    if (ticketId) {
      const ticketNodeId = graph.upsertNode("Ticket", ticketId, {
        ticket_id: ticketId,
        identifier: asJson(row.identifier),
        source: "factory-log",
      });
      graph.addEdge("IMPLEMENTS", executionNodeId, ticketNodeId);
    }

    const gateDecision = asString(row.gate_decision);
    if (gateDecision && gateDecision !== "unknown") {
      const gateNodeId = graph.upsertNode("GateDecision", executionId, {
        execution_id: executionId,
        decision: gateDecision,
        decided_at: asJson((parseMaybeJson(row.stages) as { decision?: unknown } | null)?.decision ?? null),
        source: "factory-log",
      });
      graph.addEdge("GATED_BY", executionNodeId, gateNodeId);
    }

    const cost = row.cost ?? row.cost_usd ?? row.total_cost_usd;
    if (typeof cost === "number") {
      const costNodeId = graph.upsertNode("CostEntry", executionId, {
        execution_id: executionId,
        amount_usd: cost,
        source: "factory-log",
      });
      graph.addEdge("INCURRED_COST", executionNodeId, costNodeId);
    }
  }
}

function ingestExecutionState(stateDir: string, graph: GraphBuilder, warnings: string[]): void {
  if (!existsSync(stateDir)) return;
  for (const file of readdirSync(stateDir).sort()) {
    if (!file.startsWith("exec-") || extname(file) !== ".json") continue;
    const path = join(stateDir, file);
    let row: ExecutionRecord;
    try {
      row = JSON.parse(readFileSync(path, "utf-8")) as ExecutionRecord;
    } catch (err) {
      warnings.push(`${path}: skipped malformed execution state (${(err as Error).message})`);
      continue;
    }

    const executionId = asString(row.execution_id);
    if (!executionId) continue;
    const executionNodeId = graph.upsertNode("Execution", executionId, {
      source: "execution-state",
      state_file: basename(path),
      ...executionProps(row),
    });

    const ticketId = asString(row.ticket_id);
    if (ticketId) {
      const ticketNodeId = graph.upsertNode("Ticket", ticketId, {
        ticket_id: ticketId,
        identifier: asJson(row.identifier),
        source: "execution-state",
      });
      graph.addEdge("IMPLEMENTS", executionNodeId, ticketNodeId);
    }

    const gateDecision = asString(row.gate_decision);
    if (gateDecision) {
      const gateNodeId = graph.upsertNode("GateDecision", executionId, {
        execution_id: executionId,
        decision: gateDecision,
        source: "execution-state",
      });
      graph.addEdge("GATED_BY", executionNodeId, gateNodeId);
    }
  }
}

function ingestLinearSources(paths: string[], graph: GraphBuilder, warnings: string[]): string[] {
  const readPaths: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    readPaths.push(path);
    const rows = path.endsWith(".jsonl") ? readJsonl(path, warnings) : readJsonFile(path, warnings);
    for (const row of rows) ingestTicketLike(row, graph);
  }
  return readPaths;
}

function ingestTicketLike(row: unknown, graph: GraphBuilder): void {
  if (!row || typeof row !== "object") return;
  const rec = row as TicketLike;
  if (Array.isArray((rec as { issues?: unknown }).issues)) {
    for (const issue of (rec as { issues: unknown[] }).issues) ingestTicketLike(issue, graph);
    return;
  }

  const ticketId = asString(rec.ticket_id) ?? asString(rec.id);
  const identifier = asString(rec.identifier);
  const key = ticketId ?? identifier;
  if (!key) return;

  graph.upsertNode("Ticket", key, {
    ticket_id: ticketId,
    identifier,
    title: asJson(rec.title),
    priority: asJson(rec.priority),
    project_id: asJson(rec.project_id),
    state_name: asJson((rec.state as { name?: unknown } | undefined)?.name),
    state_type: asJson((rec.state as { type?: unknown } | undefined)?.type),
    labels: asJson(
      Array.isArray(rec.labels)
        ? rec.labels.map((label) => (label && typeof label === "object" ? (label as { name?: unknown }).name : label))
        : rec.labels,
    ),
    team_key: asJson((rec.team as { key?: unknown } | undefined)?.key),
    source: "linear",
  });
}

function mapFkEdgesFromDb(inspection: DbInspection, graph: GraphBuilder): void {
  const nodeByTable = new Map<string, NodeLabel>([
    ["executions", "Execution"],
    ["execution", "Execution"],
    ["tickets", "Ticket"],
    ["linear_tickets", "Ticket"],
    ["cost_entries", "CostEntry"],
    ["costs", "CostEntry"],
    ["gate_decisions", "GateDecision"],
    ["factory_records", "FactoryRecord"],
  ]);
  const edgeByLabels = new Map<string, EdgeType>([
    ["Execution->Ticket", "IMPLEMENTS"],
    ["Execution->CostEntry", "INCURRED_COST"],
    ["CostEntry->Execution", "INCURRED_COST"],
    ["Execution->GateDecision", "GATED_BY"],
    ["GateDecision->Execution", "GATED_BY"],
    ["Execution->FactoryRecord", "HAS_RECORD"],
    ["FactoryRecord->Execution", "HAS_RECORD"],
  ]);

  for (const fk of inspection.foreignKeys) {
    const fromLabel = nodeByTable.get(fk.table.toLowerCase());
    const toLabel = nodeByTable.get(fk.toTable.toLowerCase());
    if (!fromLabel || !toLabel) continue;
    const edgeType = edgeByLabels.get(`${fromLabel}->${toLabel}`);
    if (!edgeType) continue;
    const from = `${fromLabel}:${fk.table}.${fk.from}`;
    const to = `${toLabel}:${fk.toTable}.${fk.to}`;
    graph.addEdge(edgeType, from, to, {
      source: "foreign-key",
      table: fk.table,
      column: fk.from,
      target_table: fk.toTable,
      target_column: fk.to,
    });
  }
}

export function extractGraph(opts: ExtractOptions): PropertyGraph {
  const warnings: string[] = [];
  const graph = new GraphBuilder();
  const db = inspectSwarmDb(opts.swarmDbPath, warnings);

  ingestFactoryLog(opts.factoryLogPath, graph, warnings);
  ingestExecutionState(opts.stateDir, graph, warnings);
  const linearSources = ingestLinearSources(opts.linearJsonPaths, graph, warnings);
  mapFkEdgesFromDb(db, graph);

  return graph.toGraph(
    {
      swarmDb: db,
      factoryLogPath: opts.factoryLogPath,
      linearSources,
    },
    warnings,
  );
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const graph = extractGraph(opts);
  const json = JSON.stringify(graph, null, opts.pretty ? 2 : 0);
  if (opts.outPath) {
    writeFileSync(opts.outPath, `${json}\n`);
  } else {
    console.log(json);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
