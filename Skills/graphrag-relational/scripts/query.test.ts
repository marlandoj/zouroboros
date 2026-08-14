import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PropertyGraph } from "./extract.ts";
import { indexPropertyGraph } from "./index.ts";
import { assertReadOnlyCypher, queryGraphRag } from "./query.ts";

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
      nodes: { Execution: 2, Ticket: 2, CostEntry: 1, GateDecision: 2, FactoryRecord: 2 },
      edges: { IMPLEMENTS: 2, INCURRED_COST: 1, GATED_BY: 2, HAS_RECORD: 2 },
    },
    nodes: [
      {
        id: "Execution:exec-alpha",
        label: "Execution",
        properties: {
          execution_id: "exec-alpha",
          identifier: "ZOU-100",
          status: "failed",
          branch_name: "factory/zou-100-module-alpha-query",
        },
      },
      {
        id: "Execution:exec-beta",
        label: "Execution",
        properties: {
          execution_id: "exec-beta",
          identifier: "ZOU-101",
          status: "complete",
          branch_name: "factory/zou-101-module-beta-query",
        },
      },
      {
        id: "Ticket:ticket-alpha",
        label: "Ticket",
        properties: { ticket_id: "ticket-alpha", identifier: "ZOU-100", title: "Module alpha query layer" },
      },
      {
        id: "Ticket:ticket-beta",
        label: "Ticket",
        properties: { ticket_id: "ticket-beta", identifier: "ZOU-101", title: "Module beta gate follow-up" },
      },
      {
        id: "CostEntry:cost-alpha",
        label: "CostEntry",
        properties: { execution_id: "exec-alpha", amount_usd: 1.25, provider: "test" },
      },
      {
        id: "GateDecision:gate-alpha",
        label: "GateDecision",
        properties: { execution_id: "exec-alpha", decision: "SWARM" },
      },
      {
        id: "GateDecision:gate-beta",
        label: "GateDecision",
        properties: { execution_id: "exec-beta", decision: "DIRECT" },
      },
      {
        id: "FactoryRecord:record-alpha",
        label: "FactoryRecord",
        properties: { kind: "execution", collected_at: "2026-07-14T00:00:00.000Z" },
      },
      {
        id: "FactoryRecord:record-beta",
        label: "FactoryRecord",
        properties: { kind: "execution", collected_at: "2026-07-14T00:01:00.000Z" },
      },
    ],
    edges: [
      { id: "implements-alpha", type: "IMPLEMENTS", from: "Execution:exec-alpha", to: "Ticket:ticket-alpha", properties: {} },
      { id: "implements-beta", type: "IMPLEMENTS", from: "Execution:exec-beta", to: "Ticket:ticket-beta", properties: {} },
      { id: "cost-alpha", type: "INCURRED_COST", from: "Execution:exec-alpha", to: "CostEntry:cost-alpha", properties: {} },
      { id: "gate-alpha", type: "GATED_BY", from: "Execution:exec-alpha", to: "GateDecision:gate-alpha", properties: {} },
      { id: "gate-beta", type: "GATED_BY", from: "Execution:exec-beta", to: "GateDecision:gate-beta", properties: {} },
      { id: "record-alpha", type: "HAS_RECORD", from: "Execution:exec-alpha", to: "FactoryRecord:record-alpha", properties: {} },
      { id: "record-beta", type: "HAS_RECORD", from: "Execution:exec-beta", to: "FactoryRecord:record-beta", properties: {} },
    ],
    sources: {
      swarmDb: { path: "missing", engine: "missing", tables: [], foreignKeys: [], errors: [] },
      factoryLogPath: "missing",
      linearSources: [],
    },
    warnings: [],
  };
}

async function indexedFixture() {
  const root = mkdtempSync(join(tmpdir(), "graphrag-query-"));
  roots.push(root);
  const factoryLog = join(root, "factory-log.jsonl");
  const graphPath = join(root, "graph.json");
  writeFileSync(factoryLog, "fixture\n");
  writeFileSync(graphPath, "{}\n");
  process.env.RAG_TELEMETRY_PATH = join(root, "telemetry.jsonl");
  const dbPath = join(root, "falkordblite");
  await indexPropertyGraph(graph(), {
    graphPath,
    dbPath,
    statePath: join(root, "state.json"),
    swarmDbPath: join(root, "swarm.db"),
    factoryLogPath: factoryLog,
    executionStateDir: join(root, "exec-state"),
    linearJsonPaths: [join(root, "linear.jsonl")],
    reset: false,
    pretty: false,
  });
  return dbPath;
}

describe("queryGraphRag", () => {
  test("emits qdrant-rag shaped ranked context blobs for gate questions", async () => {
    const dbPath = await indexedFixture();
    const results = await queryGraphRag({ dbPath, question: "What did the gate say about tickets related to module alpha?", limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].content).toBe("string");
    expect(typeof results[0].score).toBe("number");
    expect(results[0].metadata.source).toBe("graphrag-relational");
    expect(results[0].metadata.template).toBe("gate_by_module");
    expect(results.some((result) => String(result.content).includes("ZOU-100"))).toBe(true);
    const event = JSON.parse(readFileSync(process.env.RAG_TELEMETRY_PATH!, "utf8").trim().split("\n").at(-1)!);
    expect(event).toMatchObject({ method: "graph", operation: "query", ok: true });
    expect(event.details).toMatchObject({ template: "gate_by_module", hops: 2 });
    expect(event).not.toHaveProperty("cypher");
  }, 30_000);

  test("runs the accepted cost traversal", async () => {
    const dbPath = await indexedFixture();
    const results = await queryGraphRag({ dbPath, question: "What was the cost breakdown for executions touching module alpha?", limit: 2 });
    expect(results[0].metadata.template).toBe("cost_breakdown");
    expect(results[0].content).toContain("1.25");
  }, 30_000);

  test("keeps direct text2cypher input read-only", () => {
    expect(() => assertReadOnlyCypher("MATCH (e:Execution) RETURN e.id LIMIT 1")).not.toThrow();
    expect(() => assertReadOnlyCypher("CREATE (e:Execution {id: 'bad'})")).toThrow("Read-only Cypher");
    expect(() => assertReadOnlyCypher("MATCH (e:Execution) SET e.payload = '{}' RETURN e")).toThrow("Write/schema");
    expect(() => assertReadOnlyCypher("MATCH (e:Execution) REMOVE e.payload RETURN e")).toThrow("Write/schema");
    expect(() => assertReadOnlyCypher("MATCH (e:Execution) RETURN e EXPORT DATABASE 'backup'")).toThrow("Write/schema");
  });

  test("records a failed query without exposing Cypher", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphrag-query-"));
    roots.push(root);
    process.env.RAG_TELEMETRY_PATH = join(root, "telemetry.jsonl");
    await expect(queryGraphRag({
      dbPath: join(root, "missing-falkordblite"),
      question: "Show execution details",
      cypher: "MATCH (e:Execution) RETURN e LIMIT 1",
      limit: 1,
    })).rejects.toThrow("not found");
    const event = JSON.parse(readFileSync(process.env.RAG_TELEMETRY_PATH, "utf8").trim());
    expect(event).toMatchObject({ method: "graph", operation: "query", ok: false, errored: true });
    expect(event.details).toMatchObject({ customCypher: true });
    expect(event).not.toHaveProperty("cypher");
  });
});
