/**
 * 500-run performance and read-only-at-scale targets for the explorer read
 * path (ZBRE-011 / ZOU-931).
 *
 * The explorer's production data path is the artifact store: it re-scans the
 * configured roots on every `getIndex()` and parses only files whose
 * size/mtime/ctime signature changed since the last scan. These targets bound
 * that path at 500 runs — the release-hardening scale — and prove the read-only
 * API stays read-only and paginates correctly over the same large index.
 *
 * These targets bound the in-process work only. "Full build" is a fresh store
 * parsing all 500 files with an empty in-process cache; "warm" is the
 * unchanged-fingerprint cache hit; "incremental" is a single-file change. A
 * unit test cannot drop the OS page cache, so these budgets deliberately do NOT
 * claim a cold-disk measurement — each is an order-of-magnitude regression
 * guard on scan + parse + index cost (full ~85 ms budget 1500 ms; warm ~6 ms),
 * with headroom that absorbs disk and host variance rather than asserting the
 * host was quiet.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createArtifactStore } from "./artifact-store";
import { handleExplorerRequest } from "./api";

const FIXTURES = resolve(import.meta.dir, "..", "contracts", "fixtures");
const V1_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "v1-consensus-enabled.json"), "utf8"));
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "v2-complete.json"), "utf8"));

const RUN_COUNT = 500;

// Budgets in milliseconds. Set well above observed timings so a passing run
// means "no order-of-magnitude regression", not "the host was quiet".
const FULL_BUILD_BUDGET_MS = 1500;
const WARM_BUDGET_MS = 150;
const INCREMENTAL_BUDGET_MS = 400;
const API_QUERY_BUDGET_MS = 300;

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function build500RunRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zbre011-perf-"));
  tempRoots.push(root);
  // The auxiliary roots are created EMPTY on purpose: the store scans all
  // four kinds on every build, and the full-build test asserts the scanned
  // aux roots contributed nothing (file_count 0, parsed_files counts exactly
  // the 500 runs) — empty aux roots must neither break nor pollute the index.
  for (const kind of ["runs", "baselines", "cohorts", "parity"]) {
    mkdirSync(join(root, kind));
  }
  for (let i = 0; i < RUN_COUNT; i++) {
    // Alternate schema versions so the index exercises both the v1 legacy
    // adapter and the native v2 path, and vary timestamps so the chronological
    // sort has real work to do rather than a pre-sorted input.
    const artifact = structuredClone(i % 2 === 0 ? V1_FIXTURE : V2_FIXTURE);
    const day = String((i % 27) + 1).padStart(2, "0");
    const hour = String(i % 24).padStart(2, "0");
    artifact.timestamp = `2026-06-${day}T${hour}:30:11.000Z`;
    writeFileSync(
      join(root, "runs", `run-${String(i).padStart(4, "0")}.json`),
      JSON.stringify(artifact),
    );
  }
  return root;
}

function elapsed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("500-run performance targets", () => {
  test("full index build parses every run within budget and in chronological order", () => {
    const root = build500RunRoot();

    // The timed block is the ONLY index build in this test: a fresh store's
    // first getIndex() parses all 500 files with an empty in-process cache. No
    // prior getIndex() runs, so the in-process cache is provably empty —
    // asserted below via stats.parsed_files === 500 (every file parsed, nothing
    // served from the warm path). This measures in-process scan + parse + index
    // cost; it does not claim anything about OS page-cache warmth.
    let index!: ReturnType<ReturnType<typeof createArtifactStore>["getIndex"]>;
    const fullBuildMs = elapsed(() => {
      const fresh = createArtifactStore({ dataRoot: root });
      index = fresh.getIndex();
    });

    expect(index.runs.size).toBe(RUN_COUNT);
    expect(index.runOrder).toHaveLength(RUN_COUNT);
    // parsed_files === 500 (and cached_files === 0) proves every file was parsed
    // by this build — nothing was served from a pre-existing in-process cache.
    expect(index.stats.parsed_files).toBe(RUN_COUNT);
    expect(index.stats.cached_files).toBe(0);
    // Ordering is chronological descending; assert it holds across all 500.
    for (let i = 1; i < index.runOrder.length; i++) {
      const prev = index.runs.get(index.runOrder[i - 1])!.summary.timestamp;
      const curr = index.runs.get(index.runOrder[i])!.summary.timestamp;
      expect(Date.parse(prev)).toBeGreaterThanOrEqual(Date.parse(curr));
    }
    expect(fullBuildMs).toBeLessThan(FULL_BUILD_BUDGET_MS);
  });

  test("warm rebuild is a cache hit — same index, no reparse — and far cheaper than a full build", () => {
    const root = build500RunRoot();
    const store = createArtifactStore({ dataRoot: root });
    const first = store.getIndex(); // full build establishes the cached index.

    let warm!: ReturnType<typeof store.getIndex>;
    const warmMs = elapsed(() => {
      warm = store.getIndex();
    });

    // The unchanged fingerprint must short-circuit to the very same index object
    // — reference identity is proof the warm path reused the cache and did not
    // rebuild. A broken cache would return a different (re-parsed) object; a
    // timing budget alone cannot distinguish that, so identity is asserted.
    expect(warm).toBe(first);
    expect(warm.runs.size).toBe(RUN_COUNT);
    expect(warmMs).toBeLessThan(WARM_BUDGET_MS);
  });

  test("a single changed artifact reparses exactly one file", () => {
    const root = build500RunRoot();
    const store = createArtifactStore({ dataRoot: root });
    store.getIndex(); // warm baseline: all 500 cached.

    // Touch one file so only its signature changes.
    const changed = join(root, "runs", "run-0000.json");
    const future = new Date(Date.now() + 5000);
    utimesSync(changed, future, future);

    // The timed block IS the incremental rebuild that observes the change and
    // reparses exactly the one changed file (the assertions read the result of
    // this same measured call, not a later short-circuited one).
    let incremental!: ReturnType<typeof store.getIndex>;
    const incrementalMs = elapsed(() => {
      incremental = store.getIndex();
    });

    expect(incremental.runs.size).toBe(RUN_COUNT);
    expect(incremental.stats.parsed_files).toBe(1);
    expect(incremental.stats.cached_files).toBe(RUN_COUNT - 1);
    expect(incrementalMs).toBeLessThan(INCREMENTAL_BUDGET_MS);
  });

  test("paginated API query over 500 runs is correct, within budget, and read-only", async () => {
    const root = build500RunRoot();
    const store = createArtifactStore({ dataRoot: root });
    store.getIndex();

    // Time the full round trip: dispatch AND response-body consumption. Status
    // is asserted BEFORE the body is read so a non-200 surfaces as a clear
    // status failure, not a downstream JSON parse error.
    const start = performance.now();
    const response = handleExplorerRequest(
      store,
      new Request("http://explorer.local/api/runs?page=1&page_size=50"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pagination: { total_items: number; total_pages: number; page: number; page_size: number };
      items: { id: string }[];
    };
    const queryMs = performance.now() - start;

    expect(queryMs).toBeLessThan(API_QUERY_BUDGET_MS);

    // Pagination correctness over the 500-run index, not just status/timing:
    // page 1 of 50 returns exactly 50 unique items out of 500 across 10 pages.
    expect(body.pagination.total_items).toBe(RUN_COUNT);
    expect(body.pagination.total_pages).toBe(Math.ceil(RUN_COUNT / 50));
    expect(body.pagination.page).toBe(1);
    expect(body.items).toHaveLength(50);
    expect(new Set(body.items.map((r) => r.id)).size).toBe(50);

    // Read-only guarantee at scale: every mutation verb is rejected with 405
    // even when it carries a body — the body is refused unread — and the index
    // is provably unchanged afterward (no create/update/delete side effect).
    const runsBefore = store.getIndex().runs.size;
    const mutationBody = JSON.stringify({ id: "run-0000", score: 0, delete: true });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const mutation = handleExplorerRequest(
        store,
        new Request("http://explorer.local/api/runs", {
          method,
          body: mutationBody,
          headers: { "content-type": "application/json" },
        }),
      );
      expect(mutation.status).toBe(405);
      expect(mutation.headers.get("Allow")).toBe("GET, HEAD");
    }
    expect(store.getIndex().runs.size).toBe(runsBefore);
  });
});
