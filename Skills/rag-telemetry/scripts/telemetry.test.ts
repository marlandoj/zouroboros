import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRagTelemetryEvent, writeRagTelemetry } from "./telemetry.ts";

const path = join(tmpdir(), `rag-telemetry-${process.pid}.jsonl`);

afterEach(() => rmSync(path, { force: true }));

describe("RAG telemetry contract", () => {
  test("bounds query and error text", () => {
    const event = buildRagTelemetryEvent({
      method: "graph",
      operation: "query",
      source: "graphrag-relational",
      ok: false,
      durationMs: 12.345,
      query: `  ${"query ".repeat(40)}  `,
      error: new Error("failure ".repeat(60)),
    });

    expect(event.schemaVersion).toBe(2);
    expect(event.durationMs).toBe(12.35);
    expect(event.queryPreview!.length).toBeLessThanOrEqual(160);
    expect(event.error!.length).toBeLessThanOrEqual(240);
    expect(event.errored).toBe(true);
    expect(event.zeroResult).toBe(false);
  });

  test("appends one private JSONL event", () => {
    const event = writeRagTelemetry({
      method: "vector",
      operation: "query",
      source: "qdrant-rag-mcp",
      ok: true,
      durationMs: 8,
      resultCount: 3,
      zeroResult: true,
      details: { collections: ["hermes-docs"] },
    }, path);

    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(event);
    expect(event.zeroResult).toBe(true);
  });
});
