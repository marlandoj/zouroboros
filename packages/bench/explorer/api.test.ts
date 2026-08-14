/**
 * Integration tests for the GET-only explorer API (ZBRE-003 / ZOU-831).
 * Served over a real ephemeral-port Bun.serve; fixtures are real
 * contract-fixture artifacts staged in a temp data root.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aggregateArtifacts } from "../contracts/result-contract";
import { createArtifactStore, type ArtifactStore } from "./artifact-store";
import { handleExplorerRequest } from "./api";

const FIXTURES = resolve(import.meta.dir, "..", "contracts", "fixtures");
const V1_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "v1-consensus-enabled.json"), "utf8"));
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "v2-complete.json"), "utf8"));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function v1Run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(V1_FIXTURE), ...overrides };
}

/** Clone of the v1 fixture with question pr-09 flipped to correct. */
function v1RunFlipped(timestamp: string): Record<string, unknown> {
  const run = v1Run({ timestamp }) as {
    scores: { overall_accuracy: number; by_category: Record<string, { correct: number; total: number; accuracy: number }> };
    questions: Array<{ question_id: string; correct: boolean }>;
  };
  const q = run.questions.find((question) => question.question_id === "pr-09");
  if (!q) throw new Error("fixture drift: pr-09 missing");
  q.correct = true;
  run.scores.overall_accuracy = 100;
  run.scores.by_category["procedural-recall"] = { correct: 3, total: 3, accuracy: 100 };
  return run;
}

const tempRoots: string[] = [];

function trackedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

let dataRoot: string;
let store: ArtifactStore;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  dataRoot = trackedTempDir("zbre003-api-");
  mkdirSync(join(dataRoot, "runs"));
  mkdirSync(join(dataRoot, "baselines"));
  mkdirSync(join(dataRoot, "parity"));
  mkdirSync(join(dataRoot, "zourobench"));

  writeJson(join(dataRoot, "runs", "ZouroBench-A.json"), v1Run());
  writeJson(join(dataRoot, "runs", "ZouroBench-B.json"), v1RunFlipped("2026-06-22T01:30:11.152Z"));
  writeJson(join(dataRoot, "runs", "ZouroBench-V2.json"), V2_FIXTURE);
  writeJson(join(dataRoot, "runs", "compression-X.json"), { runAt: "2026-06-03", production: {} });
  writeFileSync(join(dataRoot, "runs", "broken.json"), "{not json");
  writeJson(join(dataRoot, "baselines", "baseline-good.json"), {
    timestamp: "2026-07-03T13-07-02.594Z",
    scores: { overall: 0.981, "procedural-recall": 0.944 },
    run_file: "x",
  });
  writeJson(join(dataRoot, "baselines", "baseline-bad.json"), { nope: true });
  writeJson(join(dataRoot, "parity", "parity-1.json"), {
    baseline_run_id: "run-1",
    baseline_overall_accuracy: 100,
    delta_overall_accuracy: 0,
    paired_questions: 2,
  });
  writeJson(join(dataRoot, "zourobench", "lineup-model-roster.json"), {
    schemaVersion: 1,
    generatedAt: "2026-08-05T11:04:18.441Z",
    policy: "active-and-promotion-candidates-v1",
    models: [
      {
        canonicalModel: "gpt-5.6-sol",
        family: "gpt",
        routes: ["byok:sol"],
        providers: ["zo-byok"],
        profiles: ["flagship"],
        roles: ["proposer"],
        lifecycleStatus: "promoted",
        routeHealth: "healthy",
        benchmarkStatus: "qualified",
        benchmarkEligible: true,
        benchmarkRunnable: true,
        benchmarkEvidence: { sourceModelIds: ["gpt-5.6-sol-live"] },
      },
      {
        canonicalModel: "gpt-5.3-codex",
        family: "gpt",
        routes: ["oc:gpt-5.3-codex"],
        providers: ["opencode"],
        profiles: ["coder"],
        roles: ["coder"],
        lifecycleStatus: "shadow",
        routeHealth: "unknown",
        benchmarkStatus: "held-route",
        benchmarkEligible: false,
        benchmarkRunnable: false,
        benchmarkEvidence: null,
      },
    ],
    unresolvedTargets: ["byok:unresolved"],
  });

  store = createArtifactStore({ dataRoot });
  server = Bun.serve({ port: 0, fetch: (req) => handleExplorerRequest(store, req) });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

async function getJson(path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe("GET /api/health", () => {
  test("reports roots, totals, and the index fingerprint", async () => {
    const { status, body, headers } = await getJson("/api/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.index_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(headers.get("x-index-fingerprint")).toBe(body.index_fingerprint);
    const byKind = Object.fromEntries(body.roots.map((r: any) => [r.kind, r]));
    expect(byKind.runs.exists).toBe(true);
    expect(byKind.cohorts.exists).toBe(false);
    expect(body.totals.valid_runs).toBe(3);
    expect(body.totals.invalid_artifacts).toBe(3);
    expect(body.totals.baselines).toBe(1);
    expect(body.totals.parity).toBe(1);
  });
});

describe("GET /api/runs", () => {
  test("lists valid runs newest-first and invalid artifacts with reasons", async () => {
    const { status, body } = await getJson("/api/runs");
    expect(status).toBe(200);
    expect(body.items.map((r: any) => r.id)).toEqual(["ZouroBench-V2", "ZouroBench-B", "ZouroBench-A"]);
    expect(body.pagination.total_items).toBe(3);
    expect(body.invalid.total).toBe(2);
    expect(body.invalid.truncated).toBe(false);
    const invalidIds = body.invalid.items.map((e: any) => e.id).sort();
    expect(invalidIds).toEqual(["broken", "compression-X"]);
    for (const entry of body.invalid.items) {
      expect(entry.reasons.length).toBeGreaterThan(0);
      expect(entry.reasons[0].code).toBeString();
    }
  });

  test("paginates deterministically", async () => {
    const page1 = await getJson("/api/runs?page=1&page_size=2");
    const page2 = await getJson("/api/runs?page=2&page_size=2");
    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items).toHaveLength(1);
    expect(page1.body.pagination.total_pages).toBe(2);
    expect(page2.body.items[0].id).toBe("ZouroBench-A");
  });

  test("filters by schema_version, benchmark, and time window", async () => {
    const v1 = await getJson("/api/runs?schema_version=1");
    expect(v1.body.items.map((r: any) => r.id).sort()).toEqual(["ZouroBench-A", "ZouroBench-B"]);
    const bench = await getJson("/api/runs?benchmark=ZouroBench");
    expect(bench.body.pagination.total_items).toBe(3);
    const windowed = await getJson("/api/runs?from=2026-06-22T00:00:00Z&to=2026-06-23T00:00:00Z");
    expect(windowed.body.items.map((r: any) => r.id)).toEqual(["ZouroBench-B"]);
  });
});

describe("GET /api/runs/:id", () => {
  test("serves the normalized run detail", async () => {
    const { status, body } = await getJson("/api/runs/ZouroBench-A");
    expect(status).toBe(200);
    expect(body.summary.schema_version).toBe(1);
    expect(body.run.questions).toHaveLength(3);
    expect(body.run.run_id.value).toBeNull();
    expect(body.run.run_id.availability_reason).toContain("v1 artifact");
  });

  test("unknown run is a structured 404", async () => {
    const { status, body } = await getJson("/api/runs/ZouroBench-nope");
    expect(status).toBe(404);
    expect(body.error.code).toBe("run_not_found");
  });

  test("invalid artifact id is a structured 409 with reasons, never served", async () => {
    const { status, body } = await getJson("/api/runs/compression-X");
    expect(status).toBe(409);
    expect(body.error.code).toBe("run_invalid");
    expect(body.error.details.reasons[0].code).toBe("foreign_schema");
  });
});

describe("path traversal and injection are rejected before any file access", () => {
  test.each([
    "/api/runs/..%2F..%2Fetc%2Fpasswd",
    "/api/runs/%2Fetc%2Fpasswd",
    "/api/runs/..%5C..%5Cwindows",
    "/api/runs/.hidden",
  ])("%s -> 400 invalid_id", async (path) => {
    const { status, body } = await getJson(path);
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_id");
  });

  test("client-collapsed dot-dot segments fall out of the API namespace", async () => {
    // fetch() collapses ../ before sending; the surviving path is simply an
    // unknown route — never a filesystem read.
    const { status, body } = await getJson("/api/runs/../../etc/passwd");
    expect(status).toBe(404);
    expect(body.error.code).toBe("unknown_route");
  });

  test("traversal in a filter id is rejected", async () => {
    const { status, body } = await getJson("/api/questions?run=..%2Fsecret");
    expect(status).toBe(400);
    expect(body.error.code).toBe("malformed_filter");
  });
});

describe("mutation methods return 405 on every API route", () => {
  const routes = [
    "/api/health",
    "/api/runs",
    "/api/runs/ZouroBench-A",
    "/api/runs/ZouroBench-A/questions",
    "/api/questions",
    "/api/reliability",
    "/api/compare?run_a=ZouroBench-A&run_b=ZouroBench-B",
    "/api/consensus",
    "/api/operations",
  ];
  const methods = ["POST", "PUT", "PATCH", "DELETE"];

  for (const method of methods) {
    test(`${method} is refused with Allow: GET`, async () => {
      for (const route of routes) {
        const res = await fetch(`${base}${route}`, { method, body: method === "DELETE" ? undefined : "{}" });
        expect(`${method} ${route} -> ${res.status}`).toBe(`${method} ${route} -> 405`);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
        const body: any = await res.json();
        expect(body.error.code).toBe("method_not_allowed");
      }
    });
  }
});

describe("HEAD requests", () => {
  test("HEAD is served as a safe method: status and headers, empty body", async () => {
    const res = await fetch(`${base}/api/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-index-fingerprint")).toMatch(/^[a-f0-9]{64}$/);
    expect(await res.text()).toBe("");
  });
});

describe("filter and pagination validation", () => {
  test.each([
    ["/api/runs?page=abc", "malformed_filter"],
    ["/api/runs?page=0", "malformed_filter"],
    ["/api/runs?page=1&page=2", "malformed_filter"],
    ["/api/runs?schema_version=3", "malformed_filter"],
    ["/api/runs?from=not-a-date", "malformed_filter"],
    ["/api/runs?from=June%2022%202026", "malformed_filter"],
    ["/api/runs?from=2026-13-99", "malformed_filter"],
    ["/api/questions?correct=maybe", "malformed_filter"],
    ["/api/runs?nope=1", "unknown_filter"],
    ["/api/health?page=1", "unknown_filter"],
    ["/api/runs?page_size=101", "page_size_too_large"],
    ["/api/runs?page_size=999999", "page_size_too_large"],
  ])("%s -> 400 %s", async (path, code) => {
    const { status, body } = await getJson(path);
    expect(status).toBe(400);
    expect(body.error.code).toBe(code);
  });

  test("out-of-range page is a structured 400", async () => {
    const { status, body } = await getJson("/api/runs?page=99&page_size=2");
    expect(status).toBe(400);
    expect(body.error.code).toBe("page_out_of_range");
    expect(body.error.details.total_pages).toBe(2);
  });

  test("compare requires both run ids", async () => {
    const { status, body } = await getJson("/api/compare?run_a=ZouroBench-A");
    expect(status).toBe(400);
    expect(body.error.code).toBe("missing_filter");
  });
});

describe("GET /api/questions", () => {
  test("flattens questions across runs with filters", async () => {
    const all = await getJson("/api/questions");
    expect(all.body.pagination.total_items).toBe(8); // 3 + 3 + 2

    const wrong = await getJson("/api/questions?correct=false");
    expect(wrong.body.pagination.total_items).toBe(2); // A:pr-09, V2:pr-02

    const scoped = await getJson("/api/questions?run=ZouroBench-B&correct=false");
    expect(scoped.body.pagination.total_items).toBe(0);

    const consensus = await getJson("/api/questions?consensus_invoked=true");
    expect(consensus.body.pagination.total_items).toBe(5); // 2 + 2 + 1

    // Tri-state honesty: "unknown" selects legacy rows with no recorded
    // evidence; they are matched by neither true nor false.
    const unknown = await getJson("/api/questions?consensus_invoked=unknown");
    expect(unknown.body.pagination.total_items).toBe(3); // A:pr-10, B:pr-10, V2:pr-02
    const asFalse = await getJson("/api/questions?consensus_invoked=false");
    expect(asFalse.body.pagination.total_items).toBe(0);
  });

  test("run-scoped question route filters by category and type", async () => {
    const { body } = await getJson("/api/runs/ZouroBench-A/questions?type=precise-count");
    expect(body.items.map((q: any) => q.question_id)).toEqual(["pr-09", "pr-10"]);
  });
});

describe("GET /api/reliability", () => {
  test("aggregate matches the contract aggregator and excludes invalid artifacts", async () => {
    const { status, body } = await getJson("/api/reliability");
    expect(status).toBe(200);

    const groundTruth = aggregateArtifacts([
      { key: "ZouroBench-V2", raw: V2_FIXTURE },
      { key: "ZouroBench-B", raw: v1RunFlipped("2026-06-22T01:30:11.152Z") },
      { key: "ZouroBench-A", raw: v1Run() },
    ]);
    expect(body.aggregate.included_runs).toBe(3);
    expect(body.aggregate.total_questions).toBe(groundTruth.total_questions);
    expect(body.aggregate.correct).toBe(groundTruth.correct);
    expect(body.aggregate.overall_accuracy).toBe(groundTruth.overall_accuracy);
    expect(body.aggregate.excluded.map((e: any) => e.key).sort()).toEqual(["broken", "compression-X"]);
    expect(body.series.total).toBe(3);
    expect(body.series.items.map((s: any) => s.run)).toEqual(["ZouroBench-A", "ZouroBench-B", "ZouroBench-V2"]);
  });
});

describe("GET /api/compare", () => {
  test("pairs questions and reports verdict flips", async () => {
    const { status, body } = await getJson("/api/compare?run_a=ZouroBench-A&run_b=ZouroBench-B");
    expect(status).toBe(200);
    expect(body.overall_delta).toBeCloseTo(33.3, 1);
    expect(body.questions.comparable).toBe(true);
    expect(body.questions.paired).toBe(3);
    expect(body.questions.flips).toEqual([
      { question_id: "pr-09", a_correct: false, b_correct: true },
    ]);
    expect(body.questions.only_in_a).toBe(0);
    const cat = body.by_category.find((c: any) => c.category === "procedural-recall");
    expect(cat.delta_accuracy).toBeCloseTo(33.3, 1);
  });
});

describe("cross-dataset comparison and offset timestamps (isolated corpus)", () => {
  test("question pairing is refused across datasets; ordering is epoch-correct", async () => {
    const isolatedRoot = trackedTempDir("zbre003-cmp-");
    mkdirSync(join(isolatedRoot, "runs"));
    writeJson(join(isolatedRoot, "runs", "ZouroBench-X.json"), v1Run());
    writeJson(
      join(isolatedRoot, "runs", "ZouroBench-Y.json"),
      v1Run({
        dataset: "data/zourobench/seed-adversarial.json",
        // String-sorts AFTER X's 01:30Z but is epoch-EARLIER (June 20 22:00Z).
        timestamp: "2026-06-21T04:00:00+06:00",
      }),
    );
    const isolatedStore = createArtifactStore({ dataRoot: isolatedRoot });

    const list = await handleExplorerRequest(isolatedStore, new Request("http://x/api/runs")).json();
    expect(list.items.map((r: any) => r.id)).toEqual(["ZouroBench-X", "ZouroBench-Y"]);

    const cmp = await handleExplorerRequest(
      isolatedStore,
      new Request("http://x/api/compare?run_a=ZouroBench-X&run_b=ZouroBench-Y"),
    ).json();
    expect(cmp.questions.comparable).toBe(false);
    expect(cmp.questions.paired).toBe(0);
    expect(cmp.questions.flips).toEqual([]);
    expect(cmp.questions.reason).toContain("not comparable");
    expect(cmp.overall_delta).toBe(0); // score deltas still reported
  });
});

describe("GET /api/consensus", () => {
  test("preserves Evidenced consensus fields and lists invoked questions", async () => {
    const { status, body } = await getJson("/api/consensus");
    expect(status).toBe(200);
    expect(body.runs.total).toBe(3);
    const v2 = body.runs.items.find((r: any) => r.run === "ZouroBench-V2");
    expect(v2.consensus.enabled).toBe(true);
    expect(v2.consensus.invocations.value).toBe(1);
    expect(body.invoked_questions.pagination.total_items).toBe(5);
    for (const row of body.invoked_questions.items) {
      expect(row.consensus_invoked).toBe(true);
    }
  });
});

describe("GET /api/operations", () => {
  test("reports latency, errors, invalid artifacts, baselines, and index state", async () => {
    const { status, body } = await getJson("/api/operations");
    expect(status).toBe(200);
    expect(body.latency.series.total).toBe(3);
    expect(body.latency.mean_of_runs.avg_retrieval_ms).toBeGreaterThan(0);
    expect(body.errors.items).toEqual([
      {
        run: "ZouroBench-V2",
        errors: [
          {
            question_id: "pr-02",
            stage: "generation",
            message: "generation aborted by BENCH_GEN_TIMEOUT_MS deadline",
          },
        ],
      },
    ]);
    expect(body.invalid.items.map((e: any) => e.id).sort()).toEqual(["baseline-bad", "broken", "compression-X"]);
    expect(body.baselines.total).toBe(1);
    expect(body.parity.total).toBe(1);
    expect(body.model_roster.status).toBe("available");
    expect(body.model_roster.total_targets).toBe(3);
    expect(body.model_roster.models.map((model: any) => model.canonical_model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.3-codex",
    ]);
    expect(body.model_roster.models[0].aliases).toEqual([
      "gpt-5.6-sol",
      "byok:sol",
      "gpt-5.6-sol-live",
    ]);
    expect(body.model_roster.unresolved_targets).toEqual(["byok:unresolved"]);
    expect(body.model_roster.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(body.index.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("deterministic cache invalidation over HTTP", () => {
  test("fingerprint is stable until a file changes, then changes", async () => {
    const first = await getJson("/api/health");
    const second = await getJson("/api/health");
    expect(second.body.index_fingerprint).toBe(first.body.index_fingerprint);

    const target = join(dataRoot, "runs", "ZouroBench-A.json");
    writeJson(target, v1Run({ timestamp: "2026-06-21T09:30:11.152Z" }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(target, later, later);

    const third = await getJson("/api/health");
    expect(third.body.index_fingerprint).not.toBe(first.body.index_fingerprint);
    const detail = await getJson("/api/runs/ZouroBench-A");
    expect(detail.body.summary.timestamp).toBe("2026-06-21T09:30:11.152Z");

    // Restore for any later assertions.
    writeJson(target, v1Run());
    const restored = new Date(Date.now() + 10_000);
    utimesSync(target, restored, restored);
  });
});

describe("performance", () => {
  test("500-run fixture serves the initial run index within 2 seconds", async () => {
    const perfRoot = trackedTempDir("zbre003-perf-");
    mkdirSync(join(perfRoot, "runs"));
    for (let i = 0; i < 500; i++) {
      const ts = `2026-06-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:30:11.${String(i).padStart(3, "0")}Z`;
      writeJson(join(perfRoot, "runs", `ZouroBench-perf-${String(i).padStart(3, "0")}.json`), v1Run({ timestamp: ts }));
    }
    const perfStore = createArtifactStore({ dataRoot: perfRoot });
    const perfServer = Bun.serve({ port: 0, fetch: (req) => handleExplorerRequest(perfStore, req) });
    try {
      const started = performance.now();
      const res = await fetch(`http://localhost:${perfServer.port}/api/runs?page_size=100`);
      const body: any = await res.json();
      const elapsed = performance.now() - started;
      expect(res.status).toBe(200);
      expect(body.pagination.total_items).toBe(500);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      perfServer.stop(true);
    }
  });
});
