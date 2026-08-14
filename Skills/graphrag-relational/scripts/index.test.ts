import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PropertyGraph } from "./extract.ts";
import { indexPropertyGraph } from "./index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.RAG_TELEMETRY_PATH;
});

function graph(): PropertyGraph {
  return {
    schema: {
      nodes: ["Execution", "Ticket", "CostEntry", "GateDecision", "FactoryRecord"],
      edges: ["IMPLEMENTS", "INCURRED_COST", "GATED_BY", "HAS_RECORD"],
    },
    counts: {
      nodes: { Execution: 1, Ticket: 1, CostEntry: 1, GateDecision: 1, FactoryRecord: 1 },
      edges: { IMPLEMENTS: 1, INCURRED_COST: 1, GATED_BY: 1, HAS_RECORD: 1 },
    },
    nodes: [
      { id: "Execution:exec-1", label: "Execution", properties: { status: "complete" } },
      { id: "Ticket:ticket-1", label: "Ticket", properties: { identifier: "ZOU-1" } },
      { id: "CostEntry:cost-1", label: "CostEntry", properties: { amount_usd: 0.1 } },
      { id: "GateDecision:gate-1", label: "GateDecision", properties: { decision: "DIRECT" } },
      { id: "FactoryRecord:record-1", label: "FactoryRecord", properties: { stage: "complete" } },
    ],
    edges: [
      { id: "implements-1", type: "IMPLEMENTS", from: "Execution:exec-1", to: "Ticket:ticket-1", properties: {} },
      { id: "cost-1", type: "INCURRED_COST", from: "Execution:exec-1", to: "CostEntry:cost-1", properties: {} },
      { id: "gate-1", type: "GATED_BY", from: "Execution:exec-1", to: "GateDecision:gate-1", properties: {} },
      { id: "record-1", type: "HAS_RECORD", from: "Execution:exec-1", to: "FactoryRecord:record-1", properties: {} },
    ],
    sources: {
      swarmDb: { path: "missing", engine: "missing", tables: [], foreignKeys: [], errors: [] },
      factoryLogPath: "missing",
      linearSources: [],
    },
    warnings: [],
  };
}

function options(root: string) {
  const factoryLog = join(root, "factory-log.jsonl");
  const graphPath = join(root, "graph.json");
  writeFileSync(factoryLog, "one-record\n");
  writeFileSync(graphPath, "{}\n");
  process.env.RAG_TELEMETRY_PATH = join(root, "telemetry.jsonl");
  return {
    graphPath,
    dbPath: join(root, "falkordblite"),
    statePath: join(root, "state.json"),
    swarmDbPath: join(root, "swarm.db"),
    factoryLogPath: factoryLog,
    executionStateDir: join(root, "exec-state"),
    linearJsonPaths: [join(root, "linear.jsonl")],
    reset: false,
    pretty: false,
  };
}

describe("indexPropertyGraph", () => {
  test("is idempotent and writes only changed entities", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphrag-index-"));
    roots.push(root);
    const opts = options(root);
    const first = await indexPropertyGraph(graph(), opts);
    expect(first.mode).toBe("full");
    expect(first.written).toEqual({ nodes: 5, edges: 4 });
    expect(Object.values(first.graph_counts.nodes).reduce((sum, count) => sum + count, 0)).toBe(5);
    expect(Object.values(first.graph_counts.edges).reduce((sum, count) => sum + count, 0)).toBe(4);
    const event = JSON.parse(readFileSync(process.env.RAG_TELEMETRY_PATH!, "utf8").trim().split("\n").at(-1)!);
    expect(event).toMatchObject({ method: "graph", operation: "index", ok: true, resultCount: 5 });
    expect(event.details).toMatchObject({ mode: "full", written: { nodes: 5, edges: 4 } });

    const second = await indexPropertyGraph(graph(), opts);
    expect(second.mode).toBe("incremental");
    expect(second.written).toEqual({ nodes: 0, edges: 0 });

    const changed = graph();
    changed.nodes[0].properties.status = "verified";
    const third = await indexPropertyGraph(changed, opts);
    expect(third.written).toEqual({ nodes: 1, edges: 0 });
    expect(Object.values(third.graph_counts.nodes).reduce((sum, count) => sum + count, 0)).toBe(5);
  }, 30_000);

  test("detects source truncation without reindexing unchanged entities", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphrag-index-"));
    roots.push(root);
    const opts = options(root);
    writeFileSync(opts.factoryLogPath, "a-longer-factory-log-record\n");
    await indexPropertyGraph(graph(), opts);
    writeFileSync(opts.factoryLogPath, "short\n");
    const result = await indexPropertyGraph(graph(), opts);
    expect(result.source_rotation_detected).toContain("factory_log");
    expect(result.written).toEqual({ nodes: 0, edges: 0 });
  }, 30_000);

  test("rejects edges whose endpoints are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphrag-index-"));
    roots.push(root);
    const opts = options(root);
    const invalid = graph();
    invalid.edges[0].to = "Ticket:missing";
    await expect(indexPropertyGraph(invalid, opts)).rejects.toThrow("missing endpoint");
    const event = JSON.parse(readFileSync(process.env.RAG_TELEMETRY_PATH!, "utf8").trim().split("\n").at(-1)!);
    expect(event).toMatchObject({ method: "graph", operation: "index", ok: false, errored: true });
  });
});
