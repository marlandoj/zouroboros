#!/usr/bin/env bun
/**
 * ZouroBench Results Explorer — production smoke test (ZBRE-012 / ZOU-840).
 *
 * Boots the private production server as a real child process and exercises it
 * over HTTP exactly as the operator would reach it — proving the surface works
 * from the production process, not only from the dev/test process. Verifies:
 *
 *   - health: the API reports the live artifact roots and a non-empty run set;
 *   - live run discovery: `/api/runs` (and a run-detail read) return live
 *     artifacts whose data root is `packages/bench/data`, across the boundary;
 *   - views: all six routes are directly addressable and serve the SPA shell;
 *   - no-write: every mutating method is refused (405) and the artifact index
 *     fingerprint is unchanged across the run.
 *
 * Writes a machine-readable evidence record and exits non-zero on any failure.
 *
 * Usage: bun packages/bench/explorer/smoke.ts [--out <path>] [--port <n>]
 */

import { spawn } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_DATA_ROOT } from "./server";
import { DEFAULT_SITE_DIST, DEFAULT_HOST, SPA_ROUTES } from "./prod-server";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(arg("--port") ?? process.env.EXPLORER_PROD_PORT ?? 7843);
const HOST = process.env.EXPLORER_HOST ?? DEFAULT_HOST;
const DATA_ROOT = process.env.EXPLORER_DATA_ROOT ?? DEFAULT_DATA_ROOT;
const SITE_DIST = process.env.EXPLORER_SITE_DIST ?? DEFAULT_SITE_DIST;
const OUT = arg("--out");
const BASE = `http://${HOST}:${PORT}`;

async function waitForHealth(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // server not up yet
    }
    await Bun.sleep(200);
  }
  return false;
}

async function main() {
  const serverPath = resolve(import.meta.dir, "prod-server.ts");
  const child = spawn({
    cmd: ["bun", serverPath],
    env: {
      ...process.env,
      EXPLORER_PROD_PORT: String(PORT),
      EXPLORER_HOST: HOST,
      EXPLORER_DATA_ROOT: DATA_ROOT,
      EXPLORER_SITE_DIST: SITE_DIST,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const checks: Check[] = [];
  let fingerprintBefore = "";

  try {
    if (!(await waitForHealth())) {
      checks.push({ name: "server_boot", ok: false, detail: `no healthy response at ${BASE}/api/health` });
      return finish(checks);
    }

    // 1. Health — live roots and a non-empty run set.
    {
      const res = await fetch(`${BASE}/api/health`);
      const body = (await res.json()) as {
        status: string;
        index_fingerprint: string;
        roots: Array<{ kind: string; path: string; exists: boolean }>;
        totals: { valid_runs: number };
      };
      fingerprintBefore = body.index_fingerprint;
      const runsRoot = body.roots.find((r) => r.kind === "runs");
      const ok =
        res.status === 200 &&
        body.status === "ok" &&
        runsRoot?.exists === true &&
        runsRoot.path.startsWith(resolve(DATA_ROOT)) &&
        body.totals.valid_runs > 0;
      checks.push({
        name: "health",
        ok,
        detail: `status=${body.status} valid_runs=${body.totals.valid_runs} runs_root=${runsRoot?.path}`,
      });
    }

    // 2. Live run discovery + run detail across the process boundary.
    {
      const res = await fetch(`${BASE}/api/runs`);
      const body = (await res.json()) as {
        pagination: { total_items: number };
        items: Array<{ id: string }>;
      };
      const firstId = body.items[0]?.id ?? "";
      const listOk =
        res.status === 200 &&
        body.pagination.total_items > 0 &&
        body.items.every((r) => r.id.startsWith("ZouroBench-"));
      let detailOk = false;
      let detailStatus = 0;
      if (firstId) {
        const detail = await fetch(`${BASE}/api/runs/${encodeURIComponent(firstId)}`);
        detailStatus = detail.status;
        detailOk = detail.status === 200;
      }
      checks.push({
        name: "live_run_discovery",
        ok: listOk && detailOk,
        detail: `total_items=${body.pagination.total_items} first=${firstId} detail_status=${detailStatus}`,
      });
    }

    // 3. All six views directly addressable.
    for (const route of SPA_ROUTES) {
      const res = await fetch(`${BASE}/${route}?state=loading`);
      const text = await res.text();
      checks.push({
        name: `view_${route}`,
        ok: res.status === 200 && text.includes("<div id=\"root\">"),
        detail: `status=${res.status} bytes=${text.length}`,
      });
    }

    // 4. No-write guarantee: mutating methods refused on both surfaces.
    for (const [path, label] of [
      ["/api/runs", "api"],
      ["/runs", "static"],
    ] as const) {
      let allRefused = true;
      const statuses: number[] = [];
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${BASE}${path}`, { method });
        statuses.push(res.status);
        if (res.status !== 405) allRefused = false;
      }
      checks.push({
        name: `no_write_${label}`,
        ok: allRefused,
        detail: `statuses=${statuses.join(",")}`,
      });
    }

    // 5. Read-only stability: the index fingerprint is unchanged after the run.
    {
      const res = await fetch(`${BASE}/api/health`);
      const body = (await res.json()) as { index_fingerprint: string };
      checks.push({
        name: "index_unchanged",
        ok: body.index_fingerprint === fingerprintBefore && fingerprintBefore.length > 0,
        detail: `before=${fingerprintBefore.slice(0, 12)} after=${body.index_fingerprint.slice(0, 12)}`,
      });
    }

    return finish(checks);
  } finally {
    child.kill();
    await child.exited;
  }
}

function finish(checks: Check[]): number {
  const passed = checks.every((c) => c.ok);
  const report = {
    ticket: "ZOU-933",
    stable_key: "ZBRE-012",
    base_url: BASE,
    host: HOST,
    private: HOST === "127.0.0.1" || HOST === "localhost",
    data_root: resolve(DATA_ROOT),
    site_dist: resolve(SITE_DIST),
    consumer: "Zouroboros operator reviewing scheduled/manual benchmark artifacts",
    result: passed ? "PASS" : "FAIL",
    checks,
  };
  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    mkdirSync(dirname(resolve(OUT)), { recursive: true });
    writeFileSync(resolve(OUT), text + "\n");
  }
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  — ${c.detail}`);
  }
  console.log(`\nSMOKE ${report.result}  (${checks.filter((c) => c.ok).length}/${checks.length} checks)`);
  process.exitCode = passed ? 0 : 1;
  return passed ? 0 : 1;
}

await main();
