#!/usr/bin/env bun
/**
 * rag-swarm-retrieval.ts — Swarm orchestrator RAG integration via zo-memory-system.
 * (Consolidated from Projects/zouroboros-rag-expansion into zouroboros monorepo)
 * Usage:
 *   bun rag-swarm-retrieval.ts --post-swarm <result-path|id>  Store episode + procedures
 *   bun rag-swarm-retrieval.ts --query "task desc"             Retrieve relevant context
 *   bun rag-swarm-retrieval.ts --stats                         Show retrieval stats
 */

import { Database } from "bun:sqlite";
import { embed, cosineSim, decodeEmbedding, MEMORY_DB, CONFIG_DB } from "./rag-core.ts";
import { resolveSwarmArtifacts, type SwarmArtifacts } from "./swarm-artifacts.ts";

// ── CLI ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i+1] ?? null : null; };
const mode = args.includes("--post-swarm") ? "post"
           : args.includes("--query")       ? "query"
           : args.includes("--stats")       ? "stats" : "usage";

// ── Semantic search via rag-core ───────────────────────────────────
async function semanticSearch(query: string, topK = 5): Promise<any[]> {
  const { querySemantic } = await import("./rag-core.ts");
  return await querySemantic(query, { topK, filterEntity: "swarm" });
}

// ── Store episode ────────────────────────────────────────────────
interface SwarmTaskResult {
  task?: Record<string, unknown> | string;
  success?: boolean;
  status?: string;
  executor?: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

interface SwarmResultData {
  status?: string;
  completedAt?: string;
  timestamp?: string;
  elapsedMs?: number;
  durationMs?: number;
  failed?: number;
  tasks?: SwarmTaskResult[];
  results?: SwarmTaskResult[];
}

function taskDetails(result: SwarmTaskResult): Record<string, unknown> {
  return typeof result.task === "object" && result.task !== null ? result.task : { ...result };
}

function taskDescription(result: SwarmTaskResult): string {
  const task = taskDetails(result);
  const description = typeof task.task === "string"
    ? task.task
    : typeof result.task === "string"
      ? result.task
      : "Unknown swarm task";
  return description;
}

function taskSucceeded(result: SwarmTaskResult): boolean {
  return result.success === true || result.status === "success";
}

function terminalOutcome(data: SwarmResultData, tasks: SwarmTaskResult[]): "success" | "failure" {
  const status = data.status?.toLowerCase() || "";
  if (status === "failed" || status === "failure" || status === "completed_with_failures") return "failure";
  if ((data.failed ?? 0) > 0 || tasks.some((task) => !taskSucceeded(task))) return "failure";
  return "success";
}

function happenedAt(data: SwarmResultData): number {
  const raw = data.completedAt || data.timestamp;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function storeProcedure(db: Database, episodeId: string, swarmId: string, result: SwarmTaskResult, index: number): void {
  const task = taskDetails(result);
  const taskId = String(task.id ?? index);
  const procedureId = `${episodeId}:task:${taskId}`;
  const executor = String(task.executor ?? result.executor ?? "unknown");
  const success = taskSucceeded(result);
  const step = {
    executor,
    taskPattern: taskDescription(result),
    outcome: success ? "success" : "failure",
    durationMs: result.durationMs ?? null,
    output: result.output ?? null,
    error: result.error ?? null,
  };

  db.run(
    `INSERT OR REPLACE INTO procedures
       (id, name, version, steps, success_count, failure_count, evolved_from, created_at, last_used_at)
     VALUES (?, ?, 1, ?, ?, ?, NULL, strftime('%s','now'), strftime('%s','now'))`,
    [procedureId, `swarm.${swarmId}.${taskId}`, JSON.stringify([step]), success ? 1 : 0, success ? 0 : 1],
  );
  db.run(
    `INSERT OR REPLACE INTO procedure_episodes (procedure_id, episode_id, rationale, outcome)
     VALUES (?, ?, ?, ?)`,
    [procedureId, episodeId, "Captured from completed swarm result", success ? "success" : "failure"],
  );
}

async function storeEpisode(input: SwarmArtifacts): Promise<"captured" | "skipped"> {
  if (!input.baseExists) {
    console.log(`Incomplete swarm skipped: ${input.swarmId} (base result missing)`);
    return "skipped";
  }
  if (!input.terminal) {
    console.log(`Incomplete swarm skipped: ${input.swarmId} (no terminal result or completion artifact)`);
    return "skipped";
  }

  const baseData = await Bun.file(input.basePath).json() as SwarmResultData;
  const completionData = input.completionPath
    ? await Bun.file(input.completionPath).json() as SwarmResultData
    : baseData;
  const tasks = baseData.results ?? baseData.tasks ?? completionData.results ?? completionData.tasks ?? [];
  const episodeId = `swarm.${input.swarmId}`;
  const outcome = terminalOutcome({ ...completionData, ...baseData }, tasks);
  const successful = tasks.filter(taskSucceeded).length;
  const summary = tasks.length > 0
    ? tasks.map((task) => taskDescription(task).slice(0, 120)).join(" | ")
    : `Swarm ${input.swarmId} completed with no recorded tasks`;

  const db = new Database(MEMORY_DB);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.run(
      `INSERT OR REPLACE INTO episodes
         (id, summary, outcome, happened_at, duration_ms, procedure_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, strftime('%s','now'))`,
      [
        episodeId,
        summary,
        outcome,
        happenedAt({ ...completionData, ...baseData }),
        baseData.elapsedMs ?? baseData.durationMs ?? completionData.durationMs ?? null,
        JSON.stringify({
          swarmId: input.swarmId,
          taskCount: tasks.length,
          successCount: successful,
          resultPath: input.basePath,
          completionPath: input.completionPath,
          tasks,
        }),
      ],
    );
    db.run("INSERT OR IGNORE INTO episode_entities (episode_id, entity) VALUES (?, ?)", [episodeId, episodeId]);
    tasks.forEach((task, index) => storeProcedure(db, episodeId, input.swarmId, task, index));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  console.log(`Episode stored: ${input.swarmId} (${tasks.length} tasks)`);
  console.log(`Procedures stored: ${tasks.length}`);
  return "captured";
}

// ── Query episodes ───────────────────────────────────────────────
async function queryEpisodes(query: string, topK=3): Promise<any[]> {
  try {
    const mem = new Database(MEMORY_DB, { readonly: true });
    const kw = query.split(" ")[0];
    const rows = mem.query(
      `SELECT e.id, e.summary, e.outcome, e.happened_at, e.metadata
         FROM episodes e
        WHERE e.summary LIKE ?1
           OR EXISTS (
             SELECT 1 FROM episode_entities ee
              WHERE ee.episode_id = e.id AND ee.entity LIKE ?1
           )
        ORDER BY e.happened_at DESC
        LIMIT ?2`,
    ).all(`%${kw}%`, topK);
    mem.close();
    return rows as any[];
  } catch { return []; }
}

// ── Stats ──────────────────────────────────────────────────────────
function showStats() {
  let epCount = 0, procCount = 0, recent: any[] = [];
  let warn = false;

  const mem = new Database(MEMORY_DB, { readonly: true });
  try {
    epCount   = (mem.query("SELECT COUNT(*) as c FROM episodes").get() as any)?.c ?? 0;
    procCount = (mem.query("SELECT COUNT(*) as c FROM procedures").get() as any)?.c ?? 0;
    recent = mem.query("SELECT id,summary,outcome,happened_at,metadata FROM episodes ORDER BY happened_at DESC LIMIT 5").all() as any[];
  } catch { warn = true; }
  mem.close();

  const cfg = new Database(CONFIG_DB, { readonly: true });
  const cfgCount = (cfg.query("SELECT COUNT(*) as c FROM rag_configs WHERE enabled=1").get() as any)?.c ?? 0;
  cfg.close();

  if (warn) console.log("⚠️  Some memory tables missing (run zo-memory-system setup)");
  console.log(`📊 Swarm Memory RAG Stats`);
  console.log(`   Episodes stored:    ${epCount}`);
  console.log(`   Procedures stored: ${procCount}`);
  console.log(`   Active RAG configs: ${cfgCount}`);
  console.log(`\n🕐 Recent episodes:`);
  if (recent.length === 0) console.log(`   (none — run a swarm with --post-swarm to populate)`);
  else for (const e of recent) {
    const d = e.happened_at ? new Date(e.happened_at * 1000).toLocaleDateString() : "?";
    console.log(`   ${e.id} (${d}) — ${e.outcome}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  switch (mode) {
    case "post": {
      const input = await resolveSwarmArtifacts(getArg("--post-swarm") ?? "");
      if (!input) {
        console.error("Missing --post-swarm argument");
        console.log(usage());
        process.exitCode = 1;
        break;
      }
      const status = await storeEpisode(input);
      console.log(`SWARM_CAPTURE_STATUS=${status}`);
      break;
    }
    case "query": {
      const [procs, eps] = await Promise.all([semanticSearch(getArg("--query")!, 3), queryEpisodes(getArg("--query")!, 3)]);
      const lines: string[] = [];
      if (procs.length > 0) {
        lines.push("[Recent similar procedures]");
        for (const p of procs) {
          const v = (p.value ?? "").slice(0, 70);
          const k = p.key ?? "";
          lines.push(`  • [${p.score.toFixed(2)}] ${p.entity ?? ""}: ${v} → ${k}`);
        }
        lines.push("");
      }
      if (eps.length > 0) {
        lines.push("[Recent episodes]");
        for (const e of eps) {
          const metadata = e.metadata ? JSON.parse(e.metadata) : {};
          const d = e.happened_at ? new Date(e.happened_at * 1000).toLocaleDateString() : "?";
          lines.push(`  • ${e.id} (${d}) — ${metadata.successCount ?? "?"}/${metadata.taskCount ?? "?"} succeeded`);
        }
      }
      console.log(lines.join("\n"));
      break;
    }
    case "stats": { showStats(); break; }
    default: {
      console.log(usage());
    }
  }
}

function usage(): string {
  return `Usage:
  bun rag-swarm-retrieval.ts --post-swarm <result-path|id>  Store episode + procedures
  bun rag-swarm-retrieval.ts --query "task desc"             Retrieve relevant context
  bun rag-swarm-retrieval.ts --stats                         Show retrieval stats

--post-swarm accepts a base result path or a bare swarm ID.
A terminal result may be self-contained (status=complete) or paired with <id>-complete.json.`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
  });
}
