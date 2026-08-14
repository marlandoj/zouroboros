import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE_DIR = join(import.meta.dir, "../..");
const RETRIEVAL_SCRIPT = join(PACKAGE_DIR, "scripts", "rag-swarm-retrieval.ts");
const tempRoot = mkdtempSync(join(tmpdir(), "rag-swarm-regression-"));
const homeDir = join(tempRoot, "home");
const resultsDir = join(homeDir, ".swarm", "results");
const completionsDir = join(tempRoot, "completions");
const dbPath = join(tempRoot, "memory.db");

mkdirSync(resultsDir, { recursive: true });
mkdirSync(completionsDir, { recursive: true });
process.env.HOME = homeDir;
process.env.SWARM_RESULTS_DIR = resultsDir;
process.env.SWARM_COMPLETIONS_DIR = completionsDir;
process.env.ZOUROBOROS_MEMORY_DB = dbPath;

function initializeDb(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','resolved','ongoing')),
      happened_at INTEGER NOT NULL,
      duration_ms INTEGER,
      procedure_id TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS episode_entities (
      episode_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      PRIMARY KEY (episode_id, entity)
    );
    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      steps TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      evolved_from TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS procedure_episodes (
      procedure_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      rationale TEXT,
      outcome TEXT,
      PRIMARY KEY (procedure_id, episode_id)
    );
  `);
  db.close();
}

initializeDb();

const { maintainSwarmMemory } = await import("../../scripts/daily-rag-maintenance.ts");

function resultTask(id: string) {
  return {
    task: { id, task: `Execute ${id}`, executor: "test-executor" },
    success: true,
    output: `${id} complete`,
    durationMs: 10,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function runRetrieval(input: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", RETRIEVAL_SCRIPT, "--post-swarm", input], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function counts(): { episodes: number; procedures: number; links: number } {
  const db = new Database(dbPath, { readonly: true });
  const episodes = (db.query("SELECT COUNT(*) AS count FROM episodes").get() as { count: number }).count;
  const procedures = (db.query("SELECT COUNT(*) AS count FROM procedures").get() as { count: number }).count;
  const links = (db.query("SELECT COUNT(*) AS count FROM procedure_episodes").get() as { count: number }).count;
  db.close();
  return { episodes, procedures, links };
}

afterEach(() => {
  for (const file of readdirSync(resultsDir)) rmSync(join(resultsDir, file), { recursive: true, force: true });
  for (const file of readdirSync(completionsDir)) rmSync(join(completionsDir, file), { recursive: true, force: true });
  const db = new Database(dbPath);
  db.exec("DELETE FROM procedure_episodes; DELETE FROM episode_entities; DELETE FROM procedures; DELETE FROM episodes;");
  db.close();
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("rag-swarm-retrieval --post-swarm", () => {
  test("captures an absolute self-contained result path containing .json exactly once", async () => {
    const id = "swarm_absolute";
    const nestedDir = join(tempRoot, "path.with.json", "results");
    const basePath = join(nestedDir, `${id}.json`);
    writeJson(basePath, {
      swarmId: id,
      status: "complete",
      completed: 1,
      failed: 0,
      elapsedMs: 25,
      results: [resultTask("ABS-1")],
    });

    const first = await runRetrieval(basePath);
    const second = await runRetrieval(basePath);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("SWARM_CAPTURE_STATUS=captured");
    expect(first.stderr).toBe("");
    expect(second.exitCode).toBe(0);
    expect(counts()).toEqual({ episodes: 1, procedures: 1, links: 1 });
  });

  test("supports a bare swarm ID with a legacy completion pair", async () => {
    const id = "swarm_bare";
    writeJson(join(resultsDir, `${id}.json`), { swarmId: id, tasks: [resultTask("BARE-1")] });
    writeJson(join(completionsDir, `${id}-complete.json`), {
      swarmId: id,
      status: "success",
      completedAt: "2026-07-20T00:00:00.000Z",
    });

    const result = await runRetrieval(id);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SWARM_CAPTURE_STATUS=captured");
    expect(counts()).toEqual({ episodes: 1, procedures: 1, links: 1 });
  });

  test("classifies a non-terminal result without a completion artifact as skipped", async () => {
    const id = "swarm_running";
    const basePath = join(resultsDir, `${id}.json`);
    writeJson(basePath, { swarmId: id, status: "running", results: [] });

    const result = await runRetrieval(basePath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SWARM_CAPTURE_STATUS=skipped");
    expect(result.stderr).toBe("");
    expect(counts()).toEqual({ episodes: 0, procedures: 0, links: 0 });
  });

  test("daily maintenance ignores completion files and stays idempotent", async () => {
    const completeId = "swarm_completed_pair";
    const incompleteId = "swarm_in_progress";
    writeJson(join(resultsDir, `${completeId}.json`), { swarmId: completeId, tasks: [resultTask("PAIR-1")] });
    writeJson(join(resultsDir, `${completeId}-complete.json`), {
      swarmId: completeId,
      status: "success",
      completedAt: "2026-07-20T00:00:00.000Z",
    });
    writeJson(join(resultsDir, `${incompleteId}.json`), { swarmId: incompleteId, status: "running", results: [] });

    const first = await maintainSwarmMemory();
    const afterFirst = counts();
    const second = await maintainSwarmMemory();

    expect(first).toEqual({ captured: 1, skipped: 1, errors: 0 });
    expect(afterFirst).toEqual({ episodes: 1, procedures: 1, links: 1 });
    expect(second).toEqual({ captured: 0, skipped: 2, errors: 0 });
    expect(counts()).toEqual(afterFirst);
  });
});
