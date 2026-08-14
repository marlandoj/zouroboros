#!/usr/bin/env bun
/**
 * Embed the local instinct store into Qdrant `instincts-semantic`.
 *
 * Each instinct is one 1536-dimensional Cosine point. The vector text is the
 * trigger and action; ranking metadata stays in the payload.
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_LIFECYCLE,
  liveness,
  type LifecycleInstinct,
} from "./lifecycle";

const COLLECTION = "instincts-semantic";
const VECTOR_SIZE = 1536;
const DEFAULT_STORE_PATH = "/home/workspace/.zo/instincts/instincts.yaml";
const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";

interface RuntimeConfig {
  qdrantUrl: string;
  qdrantKey: string;
}

interface PointPayload {
  inst_id: string;
  trigger: string;
  action: string;
  domain: string;
  confidence: number;
  last_seen: string;
  critical: boolean;
  reinforced_count: number;
  liveness_at_ingest: number;
}

interface QdrantPoint {
  id: number;
  vector: number[];
  payload: PointPayload;
}

function hydrateOpenAiKey(): void {
  if (process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY) return;
  try {
    const secretPath = process.env.ZO_SECRETS_PATH || "/root/.zo_secrets";
    const raw = readFileSync(secretPath, "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^export\s+(\w+)="?([^\"]*)"?$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {}
}

function runtimeConfig(): RuntimeConfig {
  return {
    qdrantUrl: (process.env.QDRANT_URL || DEFAULT_QDRANT_URL).replace(
      /\/$/,
      ""
    ),
    qdrantKey: process.env.QDRANT_API_KEY || "",
  };
}

function qHeaders(config: RuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.qdrantKey) headers["api-key"] = config.qdrantKey;
  return headers;
}

async function qReq(
  config: RuntimeConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const response = await fetch(`${config.qdrantUrl}${path}`, {
    method,
    headers: qHeaders(config),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Qdrant ${method} ${path}: ${response.status} ${await response.text()}`
    );
  }
  return response.json();
}

async function ensureCollection(
  config: RuntimeConfig,
  recreate: boolean
): Promise<void> {
  const response = await fetch(
    `${config.qdrantUrl}/collections/${COLLECTION}`,
    {
      headers: qHeaders(config),
    }
  );
  if (response.ok) {
    const existing = await response.json();
    if (recreate) {
      console.log(`  collection '${COLLECTION}' exists, recreating...`);
      await qReq(config, "DELETE", `/collections/${COLLECTION}`);
    } else {
      const vectors = existing.result?.config?.params?.vectors;
      if (vectors?.size !== VECTOR_SIZE || vectors?.distance !== "Cosine") {
        throw new Error(
          `collection '${COLLECTION}' has incompatible vectors; run with --recreate`
        );
      }
      console.log(`  collection '${COLLECTION}' exists, reusing.`);
      return;
    }
  } else if (response.status !== 404) {
    throw new Error(
      `Qdrant GET collection: ${response.status} ${await response.text()}`
    );
  }

  await qReq(config, "PUT", `/collections/${COLLECTION}`, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    on_disk_payload: true,
  });
  console.log(`  collection '${COLLECTION}' ready.`);
}

const CONTROL_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u0008" +
    "\\u000B\\u000C" +
    "\\u000E-\\u001F" +
    "\\uFEFF" +
    "]",
  "g"
);

function sanitize(value: string): string {
  let clean = value.replace(CONTROL_CHARS, "");
  clean = clean.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  clean = clean.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return clean;
}

function sanitizePoint(point: QdrantPoint): QdrantPoint {
  const payload = { ...point.payload };
  for (const key of Object.keys(payload) as Array<keyof PointPayload>) {
    const value = payload[key];
    if (typeof value === "string")
      (payload as Record<string, unknown>)[key] = sanitize(value);
  }
  return { ...point, payload };
}

async function upsert(
  config: RuntimeConfig,
  points: QdrantPoint[]
): Promise<void> {
  if (points.length === 0) return;
  const cleaned = points.map(sanitizePoint);
  try {
    await qReq(config, "PUT", `/collections/${COLLECTION}/points?wait=true`, {
      points: cleaned,
    });
    return;
  } catch {
    const failures: string[] = [];
    for (const point of cleaned) {
      try {
        await qReq(
          config,
          "PUT",
          `/collections/${COLLECTION}/points?wait=true`,
          { points: [point] }
        );
      } catch (error) {
        failures.push(`${point.payload.inst_id}: ${(error as Error).message}`);
      }
    }
    if (failures.length > 0)
      throw new Error(`failed to upsert ${failures.join("; ")}`);
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function validateSince(value: string | undefined): void {
  if (!value) return;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw new Error(`invalid --since date '${value}'; expected YYYY-MM-DD`);
  }
}

export function pointId(instId: string): number {
  if (!/^inst_\d+$/.test(instId))
    throw new Error(`invalid instinct id '${instId}'`);
  const id = parseInt(instId.slice(5), 10);
  if (!Number.isSafeInteger(id))
    throw new Error(`invalid instinct id '${instId}'`);
  return id;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function collectionPointCount(config: RuntimeConfig): Promise<number> {
  const exact = await qReq(
    config,
    "POST",
    `/collections/${COLLECTION}/points/count`,
    { exact: true }
  );
  const count = exact.result?.count;
  if (!Number.isInteger(count))
    throw new Error("Qdrant did not return an exact integer point count");

  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await qReq(config, "GET", `/collections/${COLLECTION}`);
    if (info.result?.points_count === count) return count;
    await Bun.sleep(100);
  }
  throw new Error(
    `Qdrant point metadata did not stabilize at exact count ${count}`
  );
}

export async function run(
  args: string[] = process.argv.slice(2)
): Promise<number> {
  hydrateOpenAiKey();
  const { loadStore } = await import("./observer");
  const config = runtimeConfig();
  const recreate = args.includes("--recreate");
  const since = argValue(args, "--since");
  const storePath = argValue(args, "--store") || DEFAULT_STORE_PATH;
  validateSince(since);
  if (recreate && since)
    throw new Error("--recreate cannot be combined with --since");

  console.log(
    `instinct-embed -> Qdrant ${
      config.qdrantUrl
    } collection=${COLLECTION} recreate=${recreate} since=${since || "all"}`
  );
  const started = Date.now();
  const instincts = loadStore(storePath).instincts as LifecycleInstinct[];
  if (instincts.length === 0)
    throw new Error(`instinct store is empty or unreadable: ${storePath}`);
  const selected = since
    ? instincts.filter((instinct) => instinct.last_seen >= since)
    : instincts;
  console.log(
    `  loaded ${instincts.length} instincts; embedding ${selected.length}`
  );

  await ensureCollection(config, recreate);
  if (selected.length > 0) {
    const { embeddings } = await import(
      "/home/workspace/Skills/zo-memory-system/scripts/model-client.ts"
    );
    const ingestDate = today();
    let batch: QdrantPoint[] = [];
    let indexed = 0;

    for (const instinct of selected) {
      const embeddingText = `${instinct.trigger}\n${instinct.action}`;
      const result = await embeddings(embeddingText, "text-embedding-3-small");
      if (result.embedding?.length !== VECTOR_SIZE) {
        throw new Error(
          `${instinct.id} returned vector size ${result.embedding?.length || 0}`
        );
      }
      batch.push({
        id: pointId(instinct.id),
        vector: result.embedding,
        payload: {
          inst_id: instinct.id,
          trigger: instinct.trigger,
          action: instinct.action,
          domain: instinct.domain,
          confidence: instinct.confidence,
          last_seen: instinct.last_seen,
          critical: instinct.critical === true,
          reinforced_count: instinct.reinforced_count,
          liveness_at_ingest: liveness(
            instinct,
            ingestDate,
            DEFAULT_LIFECYCLE.halfLifeDays
          ),
        },
      });
      indexed++;
      if (batch.length === 32) {
        await upsert(config, batch);
        batch = [];
        process.stdout.write(".");
      }
    }
    await upsert(config, batch);
    console.log(
      `\n  indexed ${indexed} instincts in ${(
        (Date.now() - started) /
        1000
      ).toFixed(1)}s`
    );
  } else {
    console.log("  no instincts matched --since");
  }

  const count = await collectionPointCount(config);
  console.log(`  collection point count: ${count}`);
  if (!since && count !== instincts.length) {
    throw new Error(
      `point count mismatch: collection=${count}, store=${instincts.length}`
    );
  }
  return count;
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
