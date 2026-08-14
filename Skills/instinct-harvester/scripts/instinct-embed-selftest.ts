#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  DEFAULT_LIFECYCLE,
  liveness,
  type LifecycleInstinct,
} from "./lifecycle";

const COLLECTION = "instincts-semantic";
const STORE_PATH = "/home/workspace/.zo/instincts/instincts.yaml";
const SCRIPT =
  "/home/workspace/Skills/instinct-harvester/scripts/instinct-embed.ts";
const REQUIRED_PAYLOAD = [
  "inst_id",
  "domain",
  "confidence",
  "last_seen",
  "liveness_at_ingest",
] as const;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL: ${name}${detail ? ` (${detail})` : ""}`);
}

function config(): { url: string; key: string } {
  return {
    url: (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, ""),
    key: process.env.QDRANT_API_KEY || "",
  };
}

function headers(): Record<string, string> {
  const out: Record<string, string> = { "Content-Type": "application/json" };
  const { key } = config();
  if (key) out["api-key"] = key;
  return out;
}

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const response = await fetch(`${config().url}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`
    );
  return response.json();
}

async function collectionInfo(): Promise<any> {
  return (await request("GET", `/collections/${COLLECTION}`)).result;
}

async function exactPointCount(): Promise<number> {
  return (
    await request("POST", `/collections/${COLLECTION}/points/count`, {
      exact: true,
    })
  ).result.count;
}

async function allPoints(): Promise<
  Array<{ id: number; payload: Record<string, unknown> }>
> {
  const points: Array<{ id: number; payload: Record<string, unknown> }> = [];
  let offset: number | string | undefined;
  do {
    const result = (
      await request("POST", `/collections/${COLLECTION}/points/scroll`, {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: false,
      })
    ).result;
    points.push(...(result.points || []));
    offset = result.next_page_offset ?? undefined;
  } while (offset !== undefined && offset !== null);
  return points;
}

async function main(): Promise<void> {
  const { loadStore } = await import("./observer");
  const instincts = loadStore(STORE_PATH).instincts as LifecycleInstinct[];
  check(
    "store is populated",
    instincts.length > 0,
    `count=${instincts.length}`
  );

  const before = await collectionInfo();
  const beforeCount = await exactPointCount();
  const vectors = before.config?.params?.vectors;
  check("vector size is 1536", vectors?.size === 1536, `size=${vectors?.size}`);
  check(
    "distance is Cosine",
    vectors?.distance === "Cosine",
    `distance=${vectors?.distance}`
  );
  check(
    "point count equals store count",
    beforeCount === instincts.length,
    `${beforeCount}/${instincts.length}`
  );

  const points = await allPoints();
  const byId = new Map(instincts.map((instinct) => [instinct.id, instinct]));
  const payloadsComplete = points.every((point) =>
    REQUIRED_PAYLOAD.every((field) => Object.hasOwn(point.payload, field))
  );
  check("every payload has required fields", payloadsComplete);

  const ingestToday = new Date().toISOString().slice(0, 10);
  let livenessMismatch = "";
  const livenessMatches = points.every((point) => {
    const instinct = byId.get(String(point.payload.inst_id));
    if (!instinct) {
      livenessMismatch = `missing instinct ${String(point.payload.inst_id)}`;
      return false;
    }
    const expected = liveness(
      instinct,
      ingestToday,
      DEFAULT_LIFECYCLE.halfLifeDays
    );
    const actual = Number(point.payload.liveness_at_ingest);
    if (Math.abs(actual - expected) > Number.EPSILON) {
      livenessMismatch = `${instinct.id}: actual=${actual}, expected=${expected}`;
      return false;
    }
    return true;
  });
  check(
    "liveness payload equals lifecycle liveness",
    livenessMatches,
    livenessMismatch
  );

  const rerun = spawnSync(process.execPath, [SCRIPT, "--recreate"], {
    cwd: "/home/workspace/Skills/instinct-harvester/scripts",
    env: {
      HOME: "/root",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    stdio: "inherit",
  });
  check(
    "recreate rerun exits successfully under env -i",
    rerun.status === 0,
    `status=${rerun.status}`
  );

  const afterCount = await exactPointCount();
  check(
    "recreate preserves identical point count",
    afterCount === beforeCount,
    `${beforeCount}->${afterCount}`
  );
  check(
    "recreate leaves no orphan count",
    afterCount === instincts.length,
    `${afterCount}/${instincts.length}`
  );

  console.log(`instinct-embed selftest: ${passed} pass / ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
