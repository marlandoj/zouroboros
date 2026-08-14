/**
 * Path-safety and determinism tests for the explorer artifact store
 * (ZBRE-003 / ZOU-831).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aggregateArtifacts } from "../contracts/result-contract";
import { createArtifactStore } from "./artifact-store";

const FIXTURES = resolve(import.meta.dir, "..", "contracts", "fixtures");
const V1_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "v1-consensus-enabled.json"), "utf8"));
const V2_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, "v2-complete.json"), "utf8"));

const tempRoots: string[] = [];

function trackedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function tempDataRoot(): string {
  const root = trackedTempDir("zbre003-store-");
  mkdirSync(join(root, "runs"));
  mkdirSync(join(root, "baselines"));
  return root;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function v1Run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(V1_FIXTURE), ...overrides };
}

describe("configuration path safety (fail closed)", () => {
  test("missing dataRoot throws", () => {
    expect(() => createArtifactStore({ dataRoot: join(tmpdir(), "zbre003-does-not-exist") })).toThrow(
      /not a directory/,
    );
  });

  test("dot-dot root escaping dataRoot throws", () => {
    const root = tempDataRoot();
    expect(() => createArtifactStore({ dataRoot: root, roots: { runs: "../outside" } })).toThrow(
      /escapes dataRoot/,
    );
  });

  test("absolute-path injection in a configured root throws", () => {
    const root = tempDataRoot();
    expect(() => createArtifactStore({ dataRoot: root, roots: { runs: "/etc" } })).toThrow(
      /escapes dataRoot/,
    );
  });

  test("symlinked root pointing outside dataRoot throws", () => {
    const root = tempDataRoot();
    const outside = trackedTempDir("zbre003-outside-");
    symlinkSync(outside, join(root, "link-runs"));
    expect(() => createArtifactStore({ dataRoot: root, roots: { runs: "link-runs" } })).toThrow(
      /escaping dataRoot/,
    );
  });

  test("root replaced by an escaping symlink AFTER construction fails closed", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());
    const store = createArtifactStore({ dataRoot: root });
    expect(store.getIndex().runs.size).toBe(1);

    // Swap the allowlisted root for a symlink escaping the data root.
    const outside = trackedTempDir("zbre003-swap-");
    writeJson(join(outside, "ZouroBench-evil.json"), v1Run());
    rmSync(join(root, "runs"), { recursive: true });
    symlinkSync(outside, join(root, "runs"));

    const index = store.getIndex();
    const runsRoot = index.roots.find((r) => r.kind === "runs");
    expect(runsRoot?.exists).toBe(true);
    expect(runsRoot?.safe).toBe(false);
    expect(runsRoot?.file_count).toBe(0);
    expect(index.runs.size).toBe(0);
    expect(store.getRun("ZouroBench-evil")).toBeUndefined();
  });
});

describe("indexing", () => {
  test("valid runs load; foreign and malformed artifacts are invalid with reasons", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());
    writeJson(join(root, "runs", "ZouroBench-V2.json"), V2_FIXTURE);
    writeJson(join(root, "runs", "compression-X.json"), { runAt: "2026-06-03", production: {} });
    writeFileSync(join(root, "runs", "broken.json"), "{not json");

    const store = createArtifactStore({ dataRoot: root });
    const index = store.getIndex();

    expect(index.runs.size).toBe(2);
    expect(index.runOrder).toEqual(["ZouroBench-V2", "ZouroBench-A"]);
    const invalidIds = index.invalid.map((entry) => entry.id).sort();
    expect(invalidIds).toEqual(["broken", "compression-X"]);
    const foreign = index.invalid.find((entry) => entry.id === "compression-X");
    expect(foreign?.reasons[0]?.code).toBe("foreign_schema");
    const broken = index.invalid.find((entry) => entry.id === "broken");
    expect(broken?.reasons[0]?.code).toBe("not_object");
    expect(broken?.reasons[0]?.message).toContain("not parseable JSON");
  });

  test("symlinked artifact files are refused with a reason and never served", () => {
    const root = tempDataRoot();
    const outside = trackedTempDir("zbre003-secret-");
    writeJson(join(outside, "secret.json"), v1Run());
    symlinkSync(join(outside, "secret.json"), join(root, "runs", "ZouroBench-link.json"));

    const store = createArtifactStore({ dataRoot: root });
    const index = store.getIndex();
    expect(index.runs.size).toBe(0);
    expect(index.invalid).toHaveLength(1);
    expect(index.invalid[0].id).toBe("ZouroBench-link");
    expect(index.invalid[0].reasons[0].message).toContain("symlink refused");
    expect(store.getRun("ZouroBench-link")).toBeUndefined();
  });

  test("subdirectories and unsafe names are ignored, never recursed into", () => {
    const root = tempDataRoot();
    mkdirSync(join(root, "runs", "nested"));
    writeJson(join(root, "runs", "nested", "ZouroBench-N.json"), v1Run());
    writeFileSync(join(root, "runs", ".hidden.json"), "{}");
    writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());

    const index = createArtifactStore({ dataRoot: root }).getIndex();
    expect(index.runs.size).toBe(1);
    const runsRoot = index.roots.find((r) => r.kind === "runs");
    expect(runsRoot?.file_count).toBe(1);
    expect(runsRoot?.ignored_entries).toBe(2);
  });

  test("run ordering is epoch-correct across mixed UTC offsets", () => {
    const root = tempDataRoot();
    // The +02:00 run string-sorts AFTER the Z run (day 03 > day 02), but its
    // epoch is EARLIER (2026-07-02T23:00Z vs 23:30Z): a lexicographic
    // descending sort would rank it newest — only an epoch sort is correct.
    writeJson(
      join(root, "runs", "ZouroBench-PlusTwo.json"),
      v1Run({ timestamp: "2026-07-03T01:00:00+02:00" }),
    );
    writeJson(
      join(root, "runs", "ZouroBench-Zulu.json"),
      v1Run({ timestamp: "2026-07-02T23:30:00.000Z" }),
    );

    const index = createArtifactStore({ dataRoot: root }).getIndex();
    expect(index.runOrder).toEqual(["ZouroBench-Zulu", "ZouroBench-PlusTwo"]);
  });

  test("missing cohorts/parity roots report exists:false without erroring", () => {
    const root = tempDataRoot();
    const index = createArtifactStore({ dataRoot: root }).getIndex();
    const byKind = Object.fromEntries(index.roots.map((r) => [r.kind, r]));
    expect(byKind.runs.exists).toBe(true);
    expect(byKind.cohorts.exists).toBe(false);
    expect(byKind.parity.exists).toBe(false);
    expect(index.cohorts).toHaveLength(0);
    expect(index.parity).toHaveLength(0);
  });

  test("baseline, cohort, and parity artifacts validate with structured reasons", () => {
    const root = tempDataRoot();
    mkdirSync(join(root, "cohorts"));
    mkdirSync(join(root, "parity"));
    writeJson(join(root, "baselines", "baseline-good.json"), {
      timestamp: "2026-07-03T13-07-02.594Z",
      scores: { overall: 0.981, "procedural-recall": 0.944 },
      run_file: "2026-07-03T13:07:02.577Z",
    });
    writeJson(join(root, "baselines", "baseline-bad.json"), { scores: { overall: "high" } });
    writeJson(join(root, "cohorts", "cohort-good.json"), {
      cohort_id: "cohort-2026-06-21",
      replicate_index: 1,
      replicate_seed: 7,
      minimum_n: 3,
      timeout_ms: null,
    });
    writeJson(join(root, "cohorts", "cohort-bad.json"), { replicate_index: 1 });
    writeJson(join(root, "parity", "parity-good.json"), {
      baseline_run_id: "run-1",
      baseline_overall_accuracy: 100,
      delta_overall_accuracy: 0,
      paired_questions: 2,
    });

    const index = createArtifactStore({ dataRoot: root }).getIndex();
    expect(index.baselines).toHaveLength(1);
    expect(index.baselines[0].overall).toBe(0.981);
    expect(index.baselines[0].categories["procedural-recall"]).toBe(0.944);
    expect(index.cohorts).toHaveLength(1);
    expect(index.parity).toHaveLength(1);
    const invalidByKind = Object.fromEntries(index.invalid.map((entry) => [entry.kind, entry]));
    expect(invalidByKind.baselines.id).toBe("baseline-bad");
    expect(invalidByKind.cohorts.id).toBe("cohort-bad");
    expect(invalidByKind.cohorts.reasons.some((r) => r.path === "$.cohort_id")).toBe(true);
  });
});

describe("bounded scans", () => {
  test("a root exceeding maxFilesPerRoot fails closed with a loud overflow flag", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "ZouroBench-1.json"), v1Run());
    writeJson(join(root, "runs", "ZouroBench-2.json"), v1Run());
    writeJson(join(root, "runs", "ZouroBench-3.json"), v1Run());

    const store = createArtifactStore({ dataRoot: root, maxFilesPerRoot: 2 });
    const index = store.getIndex();
    const runsRoot = index.roots.find((r) => r.kind === "runs");
    expect(runsRoot?.overflow).toBe(true);
    expect(runsRoot?.file_count).toBe(0);
    expect(index.runs.size).toBe(0);

    const roomy = createArtifactStore({ dataRoot: root, maxFilesPerRoot: 100 });
    expect(roomy.getIndex().runs.size).toBe(3);
  });
});

describe("id safety at the lookup layer", () => {
  test.each(["../ZouroBench-A", "/etc/passwd", "a/b", "a\\b", ".hidden", ""])(
    "unsafe id %j never reaches the filesystem",
    (id) => {
      const root = tempDataRoot();
      writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());
      expect(createArtifactStore({ dataRoot: root }).getRun(id)).toBeUndefined();
    },
  );
});

describe("deterministic cache invalidation", () => {
  test("unchanged disk state yields an identical fingerprint and zero re-parses", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());
    writeJson(join(root, "runs", "ZouroBench-B.json"), v1Run({ timestamp: "2026-06-22T01:30:11.152Z" }));

    const store = createArtifactStore({ dataRoot: root });
    const first = store.getIndex();
    expect(first.stats.parsed_files).toBe(2);
    const second = store.getIndex();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second).toBe(first);

    // Determinism across store instances too: same disk => same fingerprint.
    const other = createArtifactStore({ dataRoot: root });
    expect(other.getIndex().fingerprint).toBe(first.fingerprint);
  });

  test("modifying one file changes the fingerprint and re-parses only that file", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());
    writeJson(join(root, "runs", "ZouroBench-B.json"), v1Run({ timestamp: "2026-06-22T01:30:11.152Z" }));

    const store = createArtifactStore({ dataRoot: root });
    const before = store.getIndex();

    writeJson(join(root, "runs", "ZouroBench-B.json"), v1Run({ timestamp: "2026-06-23T01:30:11.152Z" }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(root, "runs", "ZouroBench-B.json"), later, later);

    const after = store.getIndex();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.stats.parsed_files).toBe(1);
    expect(after.stats.cached_files).toBe(1);
    expect(after.runs.get("ZouroBench-B")?.summary.timestamp).toBe("2026-06-23T01:30:11.152Z");
  });

  test("same-size content rewrite with a restored mtime still invalidates (ctime)", () => {
    const root = tempDataRoot();
    const target = join(root, "runs", "ZouroBench-A.json");
    // Fixed-width payloads: identical byte length before and after. Pin the
    // mtime to whole-millisecond precision so it can be restored exactly.
    const pinned = new Date("2026-06-21T01:30:11.000Z");
    writeJson(target, v1Run({ dataset: "data/zourobench/seed-AAAA.json" }));
    utimesSync(target, pinned, pinned);
    const store = createArtifactStore({ dataRoot: root });
    const before = store.getIndex();
    const stat = statSync(target);
    expect(before.runs.get("ZouroBench-A")?.run.dataset).toBe("data/zourobench/seed-AAAA.json");

    // Cross a ctime tick (filesystem timestamp granularity) before rewriting.
    Bun.sleepSync(20);
    writeJson(target, v1Run({ dataset: "data/zourobench/seed-BBBB.json" }));
    utimesSync(target, pinned, pinned); // adversarially restore mtime
    expect(statSync(target).size).toBe(stat.size);
    expect(statSync(target).mtimeMs).toBe(stat.mtimeMs);

    const after = store.getIndex();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.runs.get("ZouroBench-A")?.run.dataset).toBe("data/zourobench/seed-BBBB.json");
  });
});

describe("aggregates", () => {
  test("invalid artifacts appear as exclusions and never contribute totals", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "ZouroBench-A.json"), v1Run());
    writeJson(join(root, "runs", "ZouroBench-V2.json"), V2_FIXTURE);
    writeJson(join(root, "runs", "compression-X.json"), { runAt: "2026-06-03" });
    writeFileSync(join(root, "runs", "broken.json"), "{not json");

    const store = createArtifactStore({ dataRoot: root });
    const aggregate = store.getAggregate();

    expect(aggregate.included_runs).toBe(2);
    expect(aggregate.excluded.map((e) => e.key).sort()).toEqual(["broken", "compression-X"]);
    for (const exclusion of aggregate.excluded) {
      expect(exclusion.errors.length).toBeGreaterThan(0);
    }

    // Ground truth: the contract aggregator over the two valid raw artifacts.
    const groundTruth = aggregateArtifacts([
      { key: "ZouroBench-V2", raw: V2_FIXTURE },
      { key: "ZouroBench-A", raw: v1Run() },
    ]);
    expect(aggregate.total_questions).toBe(groundTruth.total_questions);
    expect(aggregate.correct).toBe(groundTruth.correct);
    expect(aggregate.overall_accuracy).toBe(groundTruth.overall_accuracy);
    expect(aggregate.by_category).toEqual(groundTruth.by_category);
  });

  test("no valid runs yields a null overall accuracy, never a fabricated zero", () => {
    const root = tempDataRoot();
    writeJson(join(root, "runs", "compression-X.json"), { runAt: "2026-06-03" });
    const aggregate = createArtifactStore({ dataRoot: root }).getAggregate();
    expect(aggregate.included_runs).toBe(0);
    expect(aggregate.overall_accuracy).toBeNull();
    expect(aggregate.excluded).toHaveLength(1);
  });
});
