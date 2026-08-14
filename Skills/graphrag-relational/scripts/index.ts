#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Graph } from "falkordblite";
import { writeRagTelemetry } from "../../rag-telemetry/scripts/telemetry.ts";
import {
  DEFAULT_FACTORY_DIR,
  extractGraph,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type NodeLabel,
  type PropertyGraph,
} from "./extract.ts";
import { openEmbeddedGraph } from "./runtime.ts";

const NODE_LABELS: NodeLabel[] = ["Execution", "Ticket", "CostEntry", "GateDecision", "FactoryRecord"];
const EDGE_ENDPOINTS: Record<EdgeType, [NodeLabel, NodeLabel]> = {
  IMPLEMENTS: ["Execution", "Ticket"],
  INCURRED_COST: ["Execution", "CostEntry"],
  GATED_BY: ["Execution", "GateDecision"],
  HAS_RECORD: ["Execution", "FactoryRecord"],
};

interface SourceFingerprint {
  path: string;
  kind: "file" | "directory" | "missing";
  size: number;
  mtime_ms: number;
  inode: number;
  digest: string;
}

interface IndexState {
  version: 1;
  last_run_at: string;
  node_hashes: Record<string, string>;
  edge_hashes: Record<string, string>;
  sources: Record<string, SourceFingerprint>;
}

export interface IndexOptions {
  graphPath: string | null;
  dbPath: string;
  statePath: string;
  swarmDbPath: string;
  factoryLogPath: string;
  executionStateDir: string;
  linearJsonPaths: string[];
  reset: boolean;
  pretty: boolean;
  redisServerPath?: string;
  modulePath?: string;
}

export interface IndexSummary {
  ok: true;
  mode: "full" | "incremental";
  db_path: string;
  state_path: string;
  extracted: { nodes: number; edges: number };
  written: { nodes: number; edges: number };
  unchanged: { nodes: number; edges: number };
  graph_counts: { nodes: Record<NodeLabel, number>; edges: Record<EdgeType, number> };
  source_rotation_detected: string[];
  duration_ms: number;
}

const DEFAULT_RUNTIME_DIR = join(DEFAULT_FACTORY_DIR, "state", "graphrag-relational");

function parseArgs(argv: string[]): IndexOptions {
  const options: IndexOptions = {
    graphPath: null,
    dbPath: join(DEFAULT_RUNTIME_DIR, "falkordblite"),
    statePath: join(DEFAULT_RUNTIME_DIR, "graphrag-state.json"),
    swarmDbPath: join(DEFAULT_FACTORY_DIR, "swarm.db"),
    factoryLogPath: join(DEFAULT_FACTORY_DIR, "state", "factory-log.jsonl"),
    executionStateDir: join(DEFAULT_FACTORY_DIR, "state"),
    linearJsonPaths: [join(DEFAULT_FACTORY_DIR, "state", "intake-ledger.jsonl")],
    reset: false,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--graph" && next) {
      options.graphPath = resolve(next);
      index++;
    } else if (arg === "--db" && next) {
      options.dbPath = resolve(next);
      index++;
    } else if (arg === "--state" && next) {
      options.statePath = resolve(next);
      index++;
    } else if (arg === "--swarm-db" && next) {
      options.swarmDbPath = resolve(next);
      index++;
    } else if (arg === "--factory-log" && next) {
      options.factoryLogPath = resolve(next);
      index++;
    } else if (arg === "--execution-state" && next) {
      options.executionStateDir = resolve(next);
      index++;
    } else if (arg === "--linear-json" && next) {
      options.linearJsonPaths.push(resolve(next));
      index++;
    } else if (arg === "--reset") {
      options.reset = true;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  options.dbPath = resolve(options.dbPath);
  options.statePath = resolve(options.statePath);
  options.swarmDbPath = resolve(options.swarmDbPath);
  options.factoryLogPath = resolve(options.factoryLogPath);
  options.executionStateDir = resolve(options.executionStateDir);
  options.linearJsonPaths = [...new Set(options.linearJsonPaths.map((path) => resolve(path)))];
  return options;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/index.ts [options]

Options:
  --graph <path>            Index an extracted property-graph JSON file
  --db <path>               Embedded FalkorDB data directory
  --state <path>            Incremental index state JSON
  --swarm-db <path>         Relational source used when --graph is omitted
  --factory-log <path>      Factory-log JSONL source
  --execution-state <path>  Execution-state directory
  --linear-json <path>      Additional Linear JSON/JSONL source; repeatable
  --reset                   Remove only the selected FalkorDB data and state before indexing
  --pretty                  Pretty-print the summary JSON
`);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function entityHash(entity: GraphNode | GraphEdge): string {
  return sha256(stableJson(entity));
}

function fingerprint(path: string): SourceFingerprint {
  if (!existsSync(path)) {
    return { path, kind: "missing", size: 0, mtime_ms: 0, inode: 0, digest: sha256("missing") };
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    return {
      path,
      kind: "file",
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      inode: Number(stat.ino),
      digest: sha256(readFileSync(path)),
    };
  }
  if (stat.isDirectory()) {
    const entries = readdirSync(path)
      .filter((name) => name.startsWith("exec-") && name.endsWith(".json"))
      .sort()
      .map((name) => {
        const item = statSync(join(path, name));
        return [name, item.size, item.mtimeMs];
      });
    return {
      path,
      kind: "directory",
      size: entries.reduce((sum, entry) => sum + Number(entry[1]), 0),
      mtime_ms: stat.mtimeMs,
      inode: Number(stat.ino),
      digest: sha256(stableJson(entries)),
    };
  }
  return { path, kind: "missing", size: 0, mtime_ms: 0, inode: 0, digest: sha256("unsupported") };
}

function sourceFingerprints(options: IndexOptions): Record<string, SourceFingerprint> {
  const sources: Record<string, SourceFingerprint> = {
    swarm_db: fingerprint(options.swarmDbPath),
    factory_log: fingerprint(options.factoryLogPath),
    execution_state: fingerprint(options.executionStateDir),
  };
  options.linearJsonPaths.forEach((path, index) => {
    sources[`linear_${index}`] = fingerprint(path);
  });
  if (options.graphPath) sources.graph = fingerprint(options.graphPath);
  return sources;
}

function loadState(path: string): IndexState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<IndexState>;
  if (parsed.version !== 1 || !parsed.node_hashes || !parsed.edge_hashes || !parsed.sources) {
    throw new Error(`Invalid index state: ${path}`);
  }
  return parsed as IndexState;
}

function writeState(path: string, state: IndexState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

function readGraph(options: IndexOptions): PropertyGraph {
  if (options.graphPath) return JSON.parse(readFileSync(options.graphPath, "utf-8")) as PropertyGraph;
  return extractGraph({
    swarmDbPath: options.swarmDbPath,
    factoryLogPath: options.factoryLogPath,
    stateDir: options.executionStateDir,
    linearJsonPaths: options.linearJsonPaths,
    outPath: null,
    pretty: false,
  });
}

function validateGraph(graph: PropertyGraph): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!NODE_LABELS.includes(node.label)) throw new Error(`Unsupported node label: ${node.label}`);
    if (nodeIds.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!(edge.type in EDGE_ENDPOINTS)) throw new Error(`Unsupported edge type: ${edge.type}`);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Edge ${edge.id} references a missing endpoint`);
    }
  }
}

async function upsertNode(graph: Graph, node: GraphNode, hash: string, indexedAt: string): Promise<void> {
  await graph.query(
    `MERGE (n:${node.label} {id: $id}) SET n.payload = $payload, n.source_hash = $source_hash, n.indexed_at = $indexed_at`,
    { params: { id: node.id, payload: stableJson(node.properties), source_hash: hash, indexed_at: indexedAt } },
  );
}

async function upsertEdge(graph: Graph, edge: GraphEdge, hash: string, indexedAt: string): Promise<void> {
  const [fromLabel, toLabel] = EDGE_ENDPOINTS[edge.type];
  await graph.query(
    `MATCH (a:${fromLabel} {id: $from}), (b:${toLabel} {id: $to}) ` +
      `MERGE (a)-[r:${edge.type} {id: $id}]->(b) ` +
      `SET r.payload = $payload, r.source_hash = $source_hash, r.indexed_at = $indexed_at`,
    {
      params: {
        from: edge.from,
        to: edge.to,
        id: edge.id,
        payload: stableJson(edge.properties),
        source_hash: hash,
        indexed_at: indexedAt,
      },
    },
  );
}

async function countQuery(graph: Graph, query: string): Promise<number> {
  const result = await graph.roQuery<{ count: number }>(query);
  return Number(result.data?.[0]?.count ?? 0);
}

async function graphCounts(graph: Graph): Promise<IndexSummary["graph_counts"]> {
  const nodes = Object.fromEntries(NODE_LABELS.map((label) => [label, 0])) as Record<NodeLabel, number>;
  const edges = Object.fromEntries(Object.keys(EDGE_ENDPOINTS).map((type) => [type, 0])) as Record<EdgeType, number>;
  for (const label of NODE_LABELS) nodes[label] = await countQuery(graph, `MATCH (n:${label}) RETURN count(n) AS count`);
  for (const type of Object.keys(EDGE_ENDPOINTS) as EdgeType[]) {
    edges[type] = await countQuery(graph, `MATCH ()-[r:${type}]->() RETURN count(r) AS count`);
  }
  return { nodes, edges };
}

function rotationSignals(
  previous: Record<string, SourceFingerprint> | null,
  current: Record<string, SourceFingerprint>,
): string[] {
  if (!previous) return [];
  const rotated: string[] = [];
  for (const [name, next] of Object.entries(current)) {
    const prior = previous[name];
    if (!prior || prior.kind !== "file" || next.kind !== "file") continue;
    if (next.size < prior.size || (prior.inode !== 0 && next.inode !== 0 && prior.inode !== next.inode)) rotated.push(name);
  }
  return rotated;
}

function emitGraphIndexTelemetry(
  started: number,
  options: IndexOptions,
  graph: PropertyGraph,
  ok: boolean,
  summary?: IndexSummary,
  error?: unknown,
): void {
  try {
    writeRagTelemetry({
      method: "graph",
      operation: "index",
      source: "graphrag-relational",
      ok,
      durationMs: performance.now() - started,
      resultCount: summary
        ? Object.values(summary.graph_counts.nodes).reduce((sum, count) => sum + count, 0)
        : 0,
      error,
      details: {
        mode: summary?.mode ?? (options.reset ? "full" : "unknown"),
        extracted: summary?.extracted ?? { nodes: graph.nodes.length, edges: graph.edges.length },
        written: summary?.written ?? null,
        unchanged: summary?.unchanged ?? null,
        graphCounts: summary?.graph_counts ?? null,
        sourceRotationDetected: summary?.source_rotation_detected ?? [],
      },
    });
  } catch (telemetryError) {
    console.error(`[rag-telemetry] graph index event write failed: ${telemetryError instanceof Error ? telemetryError.message : String(telemetryError)}`);
  }
}

export async function indexPropertyGraph(graph: PropertyGraph, options: IndexOptions): Promise<IndexSummary> {
  const started = performance.now();
  try {
    validateGraph(graph);
    if (options.reset) {
      rmSync(options.dbPath, { recursive: true, force: true });
      rmSync(options.statePath, { force: true });
    }

    mkdirSync(dirname(options.dbPath), { recursive: true });
    const previous = loadState(options.statePath);
    const sources = sourceFingerprints(options);
    const nodeHashes = Object.fromEntries(graph.nodes.map((node) => [node.id, entityHash(node)]));
    const edgeHashes = Object.fromEntries(graph.edges.map((edge) => [edge.id, entityHash(edge)]));
    const changedNodes = graph.nodes.filter((node) => previous?.node_hashes[node.id] !== nodeHashes[node.id]);
    const changedEdges = graph.edges.filter((edge) => previous?.edge_hashes[edge.id] !== edgeHashes[edge.id]);
    const indexedAt = new Date().toISOString();

    const session = await openEmbeddedGraph({
      path: options.dbPath,
      redisServerPath: options.redisServerPath,
      modulePath: options.modulePath,
    });
    try {
      for (const node of changedNodes) await upsertNode(session.graph, node, nodeHashes[node.id], indexedAt);
      for (const edge of changedEdges) await upsertEdge(session.graph, edge, edgeHashes[edge.id], indexedAt);
      const counts = await graphCounts(session.graph);
      writeState(options.statePath, {
        version: 1,
        last_run_at: indexedAt,
        node_hashes: nodeHashes,
        edge_hashes: edgeHashes,
        sources,
      });
      const summary: IndexSummary = {
        ok: true,
        mode: previous ? "incremental" : "full",
        db_path: options.dbPath,
        state_path: options.statePath,
        extracted: { nodes: graph.nodes.length, edges: graph.edges.length },
        written: { nodes: changedNodes.length, edges: changedEdges.length },
        unchanged: {
          nodes: graph.nodes.length - changedNodes.length,
          edges: graph.edges.length - changedEdges.length,
        },
        graph_counts: counts,
        source_rotation_detected: rotationSignals(previous?.sources ?? null, sources),
        duration_ms: Number((performance.now() - started).toFixed(2)),
      };
      emitGraphIndexTelemetry(started, options, graph, true, summary);
      return summary;
    } finally {
      await session.close();
    }
  } catch (error) {
    emitGraphIndexTelemetry(started, options, graph, false, undefined, error);
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const graph = readGraph(options);
  const summary = await indexPropertyGraph(graph, options);
  console.log(JSON.stringify(summary, null, options.pretty ? 2 : 0));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
