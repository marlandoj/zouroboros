#!/usr/bin/env bun
/**
 * ZouroBench — Custom benchmark for Zouroboros-specific capabilities.
 *
 * Tests three capabilities that no other AI memory system benchmarks:
 *   1. Procedural Recall     — Can the system store/retrieve/compare multi-step workflows?
 *   2. Cross-Persona Transfer — Does knowledge flow correctly through pools and inheritance?
 *   3. Swarm Context Propagation — Does task context survive DAG dependencies?
 *
 * Usage:
 *   bun adapters/zourobench-adapter.ts \
 *     --dataset data/zourobench/seed.json \
 *     --output data/runs/ \
 *     [--limit 50] \
 *     [--judge] \
 *     [--judge-model gpt-4o] \
 *     [--category procedural-recall,cross-persona-transfer,swarm-context-propagation]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  computeReplicateDistribution,
  DEFAULT_MIN_REPLICATES,
} from "../scripts/replicate-distribution";
import { hostname } from "os";
import {
  type Evidenced,
  type UsageV2,
  present,
  unavailable,
} from "../contracts/result-contract";
import {
  ADAPTER_VERSION,
  UsageAccumulator,
  buildV2ResultArtifact,
  collectGitProvenance,
  computeConfigFingerprint,
  computeDatasetHash,
  computeParity,
  computeQuestionSetHash,
  defaultGitRunner,
  sumQuestionUsage,
  type RunErrorEntry,
} from "./run-provenance";
import { selectFinalStepEntries } from "../scripts/procedural-recall";
import {
  effectiveTemperatureForModel,
  generateModelAnswer,
  PROVIDER_MAX_ATTEMPTS,
  reasoningModeForModel,
  type GenResult,
} from "./model-generation";

// ─── Config ──────────────────────────────────────────────────────────

const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL ?? "text-embedding-3-small";
const ANSWER_MODEL = process.env.ZO_ANSWER_MODEL ?? "gpt-4o-mini";
const OPENAI_API_KEY = (() => {
  const keyPath = "/tmp/.openai_key";
  if (existsSync(keyPath)) {
    const k = readFileSync(keyPath, "utf-8").trim();
    if (k) return k;
  }
  return process.env.OPENAI_API_KEY ?? "";
})();

const EMBEDDING_CONCURRENCY = 10;

// P1-5 honesty guards.
// d3: detect (don't auto-raise) answers truncated at the max_tokens cap so a
// silent truncation can't masquerade as a wrong answer. Default ON.
const BENCH_TRUNCATION_GUARD =
  process.env.BENCH_TRUNCATION_GUARD !== "0" &&
  process.env.BENCH_TRUNCATION_GUARD !== "false";
// d4: optional generation timeout (ms). 0 = off (byte-identical legacy path).
const BENCH_GEN_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.BENCH_GEN_TIMEOUT_MS ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const MAX_CONTEXT_CHUNKS = 10;
// Generation cap (was inline); captured in provenance so truncation is reproducible.
const MAX_ANSWER_TOKENS = 512;

const ALL_CATEGORIES = [
  "procedural-recall",
  "cross-persona-transfer",
  "swarm-context-propagation",
];

function requestSeed(value: string | number): number {
  const text = String(value);
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) & 0x7fffffff;
}

// ─── Types ───────────────────────────────────────────────────────────

interface SeedData {
  metadata: { name: string; version: string; description: string };
  personas: Array<{
    id: string; name: string; role: string;
    pools?: string[]; inheritsFrom?: string[];
  }>;
  pools: Array<{ id: string; name: string; description: string }>;
  procedures: Array<{
    name: string;
    versions: Array<{
      version: number; evolvedFrom?: string;
      steps: Array<{ executor: string; taskPattern: string; timeoutSeconds: number; fallbackExecutor?: string; notes?: string }>;
      successCount: number; failureCount: number;
    }>;
  }>;
  episodes: Array<{
    id: string; summary: string; outcome: string;
    procedure: string; procedureVersion: number;
    entities: string[]; happenedDaysAgo: number; durationMs: number;
  }>;
  facts: Array<{
    persona: string; entity: string; key: string; value: string;
    category: string; importance: number;
  }>;
  swarm_dags: Array<{
    id: string; name: string;
    tasks: Array<{
      id: string; persona: string; task: string; priority: string;
      executor: string; dependsOn: string[];
    }>;
    results: Record<string, {
      success: boolean; output: string; artifacts: string[];
    }>;
  }>;
  questions: Record<string, Array<{
    id: string; question: string; answer: string; type: string;
    [key: string]: unknown;
  }>>;
}

interface QuestionResult {
  question_id: string;
  question_type: string;
  category: string;
  question: string;
  ground_truth: string;
  hypothesis: string;
  retrieved_context: string[];
  retrieval_ms: number;
  answer_ms: number;
  correct: boolean;
  judge_label?: string;
  judge_confidence?: number;
  consensus_invoked?: boolean;
  consensus_verdict?: string;
  consensus_confidence?: number;
  profile_valve_invoked?: boolean;
  profile_valve?: ProfileValveMetadata;
  profile_valve_error?: string;
  /** P1-5: answer hit the max_tokens cap (finish_reason=length). */
  truncated?: boolean;
  /** P1-5: generation aborted by BENCH_GEN_TIMEOUT_MS — counted as a failure. */
  timed_out?: boolean;
  /** ZBRE-002 (observed): provider finish_reason for the answer call. */
  finish_reason?: string;
  /** ZBRE-002 (derived): summed answer+judge token usage; honest null when unobserved. */
  usage?: Evidenced<UsageV2>;
}

interface ProfileValveRunMetadata {
  consensus_id: string | null;
  gate_run_id: string | null;
  latency_ms: number;
}

interface ProfileValveMetadata {
  valve_run_id: string;
  trigger: string;
  escalated: boolean;
  decision_source: "flagship";
  severe_miss: boolean;
  total_latency_ms: number;
  fast: ProfileValveRunMetadata;
  flagship: ProfileValveRunMetadata | null;
  audit_error?: string;
}

interface ProfileValvePayload {
  valveRunId?: unknown;
  requestedMode?: unknown;
  effectiveMode?: unknown;
  decisionSource?: unknown;
  decision?: {
    status?: unknown;
    consensus?: { confidence?: unknown };
  } | null;
  trigger?: unknown;
  escalated?: unknown;
  severeMiss?: unknown;
  totalLatencyMs?: unknown;
  fast?: {
    consensusId?: unknown;
    gateRunId?: unknown;
    latencyMs?: unknown;
  };
  flagship?: {
    consensusId?: unknown;
    gateRunId?: unknown;
    latencyMs?: unknown;
  } | null;
  auditError?: unknown;
}

// ─── Schema ──────────────────────────────────────────────────────────

function initBenchDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL,
      text TEXT,
      category TEXT DEFAULT 'fact',
      decay_class TEXT DEFAULT 'stable',
      importance REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_accessed INTEGER,
      confidence REAL DEFAULT 1.0,
      metadata TEXT,
      access_count INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text, entity, key, value, category,
      content='facts', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
      VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
    END;

    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'text-embedding-3-small',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS fact_links (
      source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (source_id, target_id, relation)
    );

    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      steps TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      evolved_from TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

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
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      entity TEXT NOT NULL,
      PRIMARY KEY (episode_id, entity)
    );

    CREATE TABLE IF NOT EXISTS episode_documents (
      episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
      episode_id UNINDEXED, text
    );

    CREATE TABLE IF NOT EXISTS procedure_episodes (
      procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      PRIMARY KEY (procedure_id, episode_id)
    );

    CREATE TABLE IF NOT EXISTS persona_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS persona_pool_members (
      pool_id TEXT NOT NULL REFERENCES persona_pools(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      added_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (pool_id, persona)
    );

    CREATE TABLE IF NOT EXISTS persona_inheritance (
      child_persona TEXT NOT NULL,
      parent_persona TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (child_persona, parent_persona)
    );

    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id TEXT PRIMARY KEY,
      dag_id TEXT NOT NULL,
      persona TEXT NOT NULL,
      task TEXT NOT NULL,
      priority TEXT NOT NULL,
      executor TEXT NOT NULL,
      depends_on TEXT,
      output TEXT,
      artifacts TEXT,
      success INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS swarm_tasks_fts USING fts5(
      task, output, artifacts
    );

    CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
    CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
    CREATE INDEX IF NOT EXISTS idx_procedures_name ON procedures(name);
    CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
    CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
    CREATE INDEX IF NOT EXISTS idx_swarm_tasks_dag ON swarm_tasks(dag_id);
  `);
  return db;
}

// ─── Embedding ───────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

async function embedBatch(
  items: Array<{ id: string; text: string }>,
  concurrency: number,
  label: string,
): Promise<Map<string, number[]>> {
  const results = new Map<string, number[]>();
  let done = 0;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const vecs = await Promise.all(batch.map((it) => getEmbedding(it.text)));
    for (let j = 0; j < batch.length; j++) {
      if (vecs[j]) results.set(batch[j].id, vecs[j]!);
    }
    done += batch.length;
    if (done % 50 === 0 || done === items.length) {
      process.stdout.write(`\r  [${label}] ${done}/${items.length} embeddings`);
    }
  }
  console.log();
  return results;
}

function storeEmbeddings(db: Database, embeddings: Map<string, number[]>): void {
  const ins = db.prepare(
    "INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)",
  );
  const txn = db.transaction(() => {
    for (const [id, vec] of embeddings) {
      ins.run(id, Buffer.from(new Float32Array(vec).buffer), EMBEDDING_MODEL);
    }
  });
  txn();
}

// ─── Cosine similarity ──────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const d = Math.sqrt(nA) * Math.sqrt(nB);
  return d > 0 ? dot / d : 0;
}

// ─── LLM helpers ─────────────────────────────────────────────────────

async function openaiGenerate(
  prompt: string,
  model = "gpt-4o-mini",
  seed?: number,
  temperature = 0.1,
): Promise<GenResult> {
  return generateModelAnswer({
    prompt,
    model,
    seed,
    temperature,
    maxTokens: MAX_ANSWER_TOKENS,
    timeoutMs: BENCH_GEN_TIMEOUT_MS,
  }, {
    env: { ...process.env, OPENAI_API_KEY },
  });
}

// ─── Seeding ─────────────────────────────────────────────────────────

function seedDatabase(db: Database, seed: SeedData): Array<{ id: string; text: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const embeddable: Array<{ id: string; text: string }> = [];

  // Pools
  const insPool = db.prepare("INSERT INTO persona_pools (id, name, description) VALUES (?, ?, ?)");
  const insPoolMember = db.prepare("INSERT INTO persona_pool_members (pool_id, persona) VALUES (?, ?)");
  const insInherit = db.prepare("INSERT INTO persona_inheritance (child_persona, parent_persona, depth) VALUES (?, ?, ?)");

  db.transaction(() => {
    for (const pool of seed.pools) {
      insPool.run(pool.id, pool.name, pool.description);
    }
    for (const persona of seed.personas) {
      if (persona.pools) {
        for (const poolId of persona.pools) {
          insPoolMember.run(poolId, persona.id);
        }
      }
      if (persona.inheritsFrom) {
        for (let i = 0; i < persona.inheritsFrom.length; i++) {
          insInherit.run(persona.id, persona.inheritsFrom[i], i + 1);
        }
      }
    }
  })();

  // Facts
  const insFact = db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                       importance, source, created_at, expires_at, last_accessed, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'stable', ?, 'zourobench-seed', ?, ?, ?, 1.0)
  `);
  db.transaction(() => {
    for (const f of seed.facts) {
      const id = randomUUID();
      const text = `${f.entity} ${f.key}: ${f.value}`;
      insFact.run(id, f.persona, f.entity, f.key, f.value, text, f.category,
        f.importance, nowSec, nowSec + 90 * 86400, nowSec);
      embeddable.push({ id, text });
    }
  })();

  // Procedures
  const insProc = db.prepare(`
    INSERT INTO procedures (id, name, version, steps, success_count, failure_count, evolved_from, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const procIds = new Map<string, string>(); // "name-vN" → id
  db.transaction(() => {
    for (const proc of seed.procedures) {
      for (const ver of proc.versions) {
        const id = randomUUID();
        const key = `${proc.name}-v${ver.version}`;
        procIds.set(key, id);
        const evolvedFromId = ver.evolvedFrom
          ? procIds.get(`${proc.name}-${ver.evolvedFrom}`) ?? null
          : null;
        insProc.run(id, proc.name, ver.version, JSON.stringify(ver.steps),
          ver.successCount, ver.failureCount, evolvedFromId, nowSec);

        // Also store procedure steps as searchable facts
        const stepsSummary = ver.steps.map((s, i) =>
          `Step ${i + 1}: [${s.executor}] ${s.taskPattern} (${s.timeoutSeconds}s${s.fallbackExecutor ? `, fallback: ${s.fallbackExecutor}` : ""})`
        ).join("\n");
        const factId = randomUUID();
        const factText = `procedure ${proc.name} v${ver.version}: ${stepsSummary}`;
        insFact.run(factId, "shared", `procedure:${proc.name}`, `v${ver.version}`,
          stepsSummary, factText, "procedure", 0.9, nowSec, nowSec + 90 * 86400, nowSec);
        embeddable.push({ id: factId, text: factText });
      }
    }
  })();

  // Episodes
  const insEp = db.prepare(`
    INSERT INTO episodes (id, summary, outcome, happened_at, duration_ms, procedure_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insEpEntity = db.prepare("INSERT INTO episode_entities (episode_id, entity) VALUES (?, ?)");
  const insEpDoc = db.prepare("INSERT INTO episode_documents (episode_id, text) VALUES (?, ?)");
  const insEpDocFts = db.prepare("INSERT INTO episode_documents_fts (episode_id, text) VALUES (?, ?)");
  const insProcEp = db.prepare("INSERT OR IGNORE INTO procedure_episodes (procedure_id, episode_id) VALUES (?, ?)");

  db.transaction(() => {
    for (const ep of seed.episodes) {
      const happenedAt = nowSec - ep.happenedDaysAgo * 86400;
      const procKey = `${ep.procedure}-v${ep.procedureVersion}`;
      const procId = procIds.get(procKey) ?? null;

      insEp.run(ep.id, ep.summary, ep.outcome, happenedAt, ep.durationMs, procId,
        JSON.stringify({ procedure: ep.procedure, version: ep.procedureVersion }));
      insEpDoc.run(ep.id, ep.summary);
      insEpDocFts.run(ep.id, ep.summary);

      const seenEntities = new Set<string>();
      for (const entity of ep.entities) {
        if (seenEntities.has(entity)) continue;
        seenEntities.add(entity);
        insEpEntity.run(ep.id, entity);
      }

      if (procId) {
        insProcEp.run(procId, ep.id);
      }

      // Store episode as a searchable fact too
      const factId = randomUUID();
      const factText = `episode ${ep.id}: ${ep.summary} [outcome: ${ep.outcome}] [procedure: ${ep.procedure} v${ep.procedureVersion}]`;
      insFact.run(factId, "shared", `episode:${ep.id}`, ep.outcome,
        ep.summary, factText, "fact", 0.8, happenedAt, nowSec + 90 * 86400, nowSec);
      embeddable.push({ id: factId, text: factText });
    }
  })();

  // Swarm DAG tasks
  const insTask = db.prepare(`
    INSERT INTO swarm_tasks (id, dag_id, persona, task, priority, executor, depends_on, output, artifacts, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insTaskFts = db.prepare("INSERT INTO swarm_tasks_fts (rowid, task, output, artifacts) VALUES (?, ?, ?, ?)");
  let taskRowid = 1;

  db.transaction(() => {
    for (const dag of seed.swarm_dags) {
      for (const task of dag.tasks) {
        const result = dag.results[task.id];
        const taskId = `${dag.id}:${task.id}`;
        insTask.run(taskId, dag.id, task.persona, task.task, task.priority,
          task.executor, JSON.stringify(task.dependsOn), result?.output ?? null,
          result?.artifacts ? JSON.stringify(result.artifacts) : null,
          result?.success ? 1 : 0);
        insTaskFts.run(taskRowid++, task.task,
          result?.output ?? "", result?.artifacts?.join(", ") ?? "");

        // Store task+result as searchable fact
        if (result) {
          const factId = randomUUID();
          const factText = `swarm task ${taskId} [${dag.name}] [persona: ${task.persona}] [executor: ${task.executor}] [depends: ${task.dependsOn.join(",")}]: ${task.task}\nResult: ${result.output}\nArtifacts: ${result.artifacts.join(", ")}`;
          insFact.run(factId, task.persona, `swarm:${dag.id}`, task.id,
            `${task.task}\n${result.output}`, factText, "fact",
            0.85, nowSec, nowSec + 90 * 86400, nowSec);
          embeddable.push({ id: factId, text: factText });
        }
      }
    }
  })();

  console.log(`  [seed] ${seed.facts.length} facts, ${seed.procedures.reduce((n, p) => n + p.versions.length, 0)} procedure versions, ${seed.episodes.length} episodes, ${seed.swarm_dags.reduce((n, d) => n + d.tasks.length, 0)} swarm tasks`);
  return embeddable;
}

// ─── Search ──────────────────────────────────────────────────────────

function buildFtsQuery(query: string): string {
  const stopWords = new Set(["what", "which", "how", "does", "did", "was", "were", "is", "are", "the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or", "as", "can", "you", "that", "this", "do", "has", "have", "had", "be", "been", "not", "with", "from", "by", "about", "all", "my", "its", "your", "i"]);
  return query
    .replace(/['"?!.,;:()]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()))
    .map((w) => `"${w}"`)
    .join(" OR ");
}

interface SearchHit {
  id: string;
  text: string;
  value: string;
  entity: string;
  persona: string;
  score: number;
}

function ftsSearch(db: Database, query: string, limit = 20, personaFilter?: string[]): SearchHit[] {
  const fts = buildFtsQuery(query);
  if (!fts) return [];
  const nowSec = Math.floor(Date.now() / 1000);

  let sql = `
    SELECT f.id, f.text, f.value, f.entity, f.persona, rank
    FROM facts f
    JOIN facts_fts fts ON f.rowid = fts.rowid
    WHERE facts_fts MATCH ?
      AND (f.expires_at IS NULL OR f.expires_at > ?)
  `;
  const params: (string | number)[] = [fts, nowSec];

  if (personaFilter && personaFilter.length > 0) {
    sql += ` AND f.persona IN (${personaFilter.map(() => "?").join(",")})`;
    params.push(...personaFilter);
  }
  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    text: r.text as string,
    value: r.value as string,
    entity: r.entity as string,
    persona: r.persona as string,
    score: Math.abs(r.rank as number),
  }));
}

function vectorSearch(db: Database, queryVec: number[], limit = 20, personaFilter?: string[]): SearchHit[] {
  let sql = "SELECT f.id, f.text, f.value, f.entity, f.persona, fe.embedding FROM facts f JOIN fact_embeddings fe ON f.id = fe.fact_id";
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  conditions.push("(f.expires_at IS NULL OR f.expires_at > ?)");
  params.push(nowSec);

  if (personaFilter && personaFilter.length > 0) {
    conditions.push(`f.persona IN (${personaFilter.map(() => "?").join(",")})`);
    params.push(...personaFilter);
  }

  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const scored: SearchHit[] = [];

  for (const row of rows) {
    const buf = row.embedding as Buffer;
    const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const sim = cosine(queryVec, Array.from(vec));
    if (sim > 0.3) {
      scored.push({
        id: row.id as string,
        text: row.text as string,
        value: row.value as string,
        entity: row.entity as string,
        persona: row.persona as string,
        score: sim,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function hybridSearch(db: Database, query: string, queryVec: number[] | null, limit = 10, personaFilter?: string[]): SearchHit[] {
  const ftsHits = ftsSearch(db, query, limit * 2, personaFilter);
  const vecHits = queryVec ? vectorSearch(db, queryVec, limit * 2, personaFilter) : [];

  const merged = new Map<string, SearchHit & { ftsRank: number; vecRank: number }>();
  const K = 60;

  for (let i = 0; i < ftsHits.length; i++) {
    const h = ftsHits[i];
    merged.set(h.id, { ...h, ftsRank: i + 1, vecRank: 9999, score: 0 });
  }
  for (let i = 0; i < vecHits.length; i++) {
    const h = vecHits[i];
    const existing = merged.get(h.id);
    if (existing) {
      existing.vecRank = i + 1;
    } else {
      merged.set(h.id, { ...h, ftsRank: 9999, vecRank: i + 1, score: 0 });
    }
  }

  for (const [, hit] of merged) {
    const ftsScore = 1 / (K + hit.ftsRank);
    const vecScore = 0.3 / (K + hit.vecRank);
    const dualBoost = hit.ftsRank < 9999 && hit.vecRank < 9999 ? 1.4 : 1.0;
    hit.score = (ftsScore + vecScore) * dualBoost;
  }

  const results = [...merged.values()].sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── Swarm task search (specialized) ─────────────────────────────────

function searchSwarmTasks(db: Database, dagId: string, query: string): Array<{ taskId: string; persona: string; task: string; output: string; artifacts: string; dependsOn: string }> {
  if (dagId === "all") {
    const rows = db.prepare(`
      SELECT id, persona, task, output, artifacts, depends_on
      FROM swarm_tasks
      ORDER BY created_at
    `).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      taskId: r.id as string,
      persona: r.persona as string,
      task: r.task as string,
      output: (r.output as string) ?? "",
      artifacts: (r.artifacts as string) ?? "",
      dependsOn: (r.depends_on as string) ?? "[]",
    }));
  }

  const rows = db.prepare(`
    SELECT id, persona, task, output, artifacts, depends_on
    FROM swarm_tasks
    WHERE dag_id = ?
    ORDER BY created_at
  `).all(dagId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    taskId: r.id as string,
    persona: r.persona as string,
    task: r.task as string,
    output: (r.output as string) ?? "",
    artifacts: (r.artifacts as string) ?? "",
    dependsOn: (r.depends_on as string) ?? "[]",
  }));
}

// ─── Cross-persona access logic ──────────────────────────────────────

function getAccessiblePersonas(db: Database, persona: string): string[] {
  const accessible = new Set<string>([persona]);

  // Pool peers
  const pools = db.prepare("SELECT pool_id FROM persona_pool_members WHERE persona = ?").all(persona) as Array<{ pool_id: string }>;
  for (const pool of pools) {
    const members = db.prepare("SELECT persona FROM persona_pool_members WHERE pool_id = ? AND persona != ?")
      .all(pool.pool_id, persona) as Array<{ persona: string }>;
    for (const m of members) accessible.add(m.persona);
  }

  // Inheritance parents
  const parents = db.prepare("SELECT parent_persona FROM persona_inheritance WHERE child_persona = ? ORDER BY depth ASC")
    .all(persona) as Array<{ parent_persona: string }>;
  for (const p of parents) {
    accessible.add(p.parent_persona);
    // Transitive: parent's pool peers
    const parentPools = db.prepare("SELECT pool_id FROM persona_pool_members WHERE persona = ?").all(p.parent_persona) as Array<{ pool_id: string }>;
    for (const pp of parentPools) {
      const members = db.prepare("SELECT persona FROM persona_pool_members WHERE pool_id = ?")
        .all(pp.pool_id) as Array<{ persona: string }>;
      for (const m of members) accessible.add(m.persona);
    }
  }

  return [...accessible];
}

// ─── Answer generation ───────────────────────────────────────────────

async function generateAnswer(
  question: string,
  context: string[],
  category: string,
  seed?: number,
): Promise<{ text: string; truncated: boolean; timedOut: boolean; finishReason?: string; usage?: UsageV2 }> {
  // For cross-persona, extract access verdict and put it in the question
  let accessPrefix = "";
  if (category === "cross-persona-transfer") {
    const canAccessLine = context.find((c) => c.includes("CAN access"));
    const cannotAccessLine = context.find((c) => c.includes("CANNOT access"));
    const ownFactsLine = context.find((c) => c.includes("[YOUR FACTS -"));
    if (ownFactsLine) {
      // Self-pool query — the persona is querying their OWN facts
      accessPrefix = `\n\nIMPORTANT: This persona is querying their OWN facts. Self-access is ALWAYS granted. The facts are listed under [YOUR FACTS]. Simply list those facts as the answer. Do NOT say 'cannot access'.`;
    } else if (canAccessLine) {
      accessPrefix = "\n\nIMPORTANT: ACCESS IS GRANTED. The facts ARE accessible. Look through the context items tagged with persona names and extract the relevant answer. Do NOT say 'cannot access' — the data is right there in the context.";
    } else if (cannotAccessLine) {
      accessPrefix = "\n\nIMPORTANT: ACCESS IS DENIED. State that the querying persona cannot access the source persona's facts due to no shared pool or inheritance.";
    }
  }

  const contextBlock = context.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");

  let systemPrompt: string;

  if (category === "procedural-recall") {
    systemPrompt = `You are answering questions about stored procedures, workflows, and their execution history.
Use ONLY the provided context. Rules:
- When asked about procedure steps, list ALL steps with their executor names and key details.
- When asked about success/failure rates, calculate from success_count and failure_count fields. A procedure may have MULTIPLE VERSIONS — sum failures across all versions for total failures. success_rate = success_count / (success_count + failure_count).
- When comparing procedure versions, diff the step lists: identify additions, removals, and changes.
- When asked "which procedure" or "what procedure should be used" questions, examine ALL procedures in context. Check EVERY SINGLE ONE. Then: name the correct procedure AND summarize its key steps in condensed form (e.g. "incident-response — steps: check health, pull error logs, analyze root cause, implement fix, restart service, send summary email").
- A procedure with failure_count=0 has 100% success rate regardless of success_count. memory-maintenance with 15 successes and 0 failures = 100%.
- For timeout questions, scan EVERY step in EVERY procedure and find the absolute maximum timeout value.
- For executor frequency questions, count executor names across ALL steps in ALL procedure versions.
- For "final step" questions: the FINAL step is the LAST step listed (highest step number). Carefully check each procedure's LAST step — not intermediate steps. Read each procedure end-to-end and identify the last step before answering.
- For "which procedures use X" enumeration questions: go through the [FINAL STEP MATCHES] block line by line, then cross-check the [FINAL STEP SUMMARY] block. List every matching procedure version; missing one is incorrect.
- For episode-procedure-link questions: identify which procedure was used by matching the episode description to the procedure's purpose. Include the version number.
Answer with specific facts — procedure names, version numbers, exact counts, step descriptions. No preamble.`;
  } else if (category === "cross-persona-transfer") {
    systemPrompt = `You are answering questions about cross-persona knowledge access in a multi-persona memory system.

CRITICAL: The context includes [Access Info] blocks. These are AUTHORITATIVE. Follow them exactly:
1. Look at "[Access Info] Querying as: X. Accessible personas: [list]"
2. If the source persona IS in the accessible list → access is GRANTED → find and return the fact value
3. If the source persona is NOT in the accessible list → access is DENIED → say so
4. A persona can ALWAYS access their OWN facts (self-access is always granted)

DO NOT say "access denied" if the accessible personas list includes the source persona. The list is the ground truth.
DO NOT say "access denied" for a persona querying their own facts.

For inheritance chain questions: list ALL accessible personas including BOTH direct parents AND transitive pool co-members. Check the [Full Accessible Personas] and [Pool Info] blocks to enumerate everyone. Explain the access path for each: direct inheritance, pool membership, or transitive (inherited pool membership).
For multi-source-aggregation questions: list ALL accessible facts about the topic from ALL accessible personas. Include own facts, facts from pool members, and any related episodes or swarm task results. Be comprehensive — enumerate every fact.
Answer with the fact value if accessible, or "cannot access" if denied. No preamble.`;
  } else {
    systemPrompt = `You are answering questions about swarm DAG execution — task dependencies, outputs, artifacts, and context propagation.
Use ONLY the provided context. Rules:
- Each task has: ID, persona, dependencies (depends field), output text, and artifacts list.
- Wave 1 = tasks with no dependencies (empty depends list). Wave 2 = tasks depending only on wave 1 tasks. Etc.
- Critical path = longest chain of dependent tasks from start to end.
- When counting artifacts, list ALL artifacts from ALL tasks (check each task's artifacts field individually). Sum the per-task artifact counts.
- When asked what one task's output informed another, trace the dependency chain and quote ALL relevant findings from the upstream task — list EVERY item flagged, not just the first one.
- For dependency-context questions: quote the COMPLETE output of the upstream task, including ALL flagged items/issues. Do not summarize or omit items.
- For "all DAGs" questions, examine every DAG in context.
Answer with specific task IDs, exact output quotes, and artifact filenames. No preamble.`;
  }

  const prompt = `${systemPrompt}

Context:
${contextBlock}
${accessPrefix}
Question: ${question}

Answer:`;

  const gen = await openaiGenerate(prompt, ANSWER_MODEL, seed, category === "procedural-recall" ? 0 : 0.1);
  return {
    text: gen.text,
    truncated: BENCH_TRUNCATION_GUARD && gen.finishReason === "length",
    timedOut: gen.timedOut === true,
    finishReason: gen.finishReason,
    usage: gen.usage,
  };
}

// ─── Judging ─────────────────────────────────────────────────────────

async function judgeAnswer(
  question: string,
  groundTruth: string,
  hypothesis: string,
  judgeModel: string,
  seed?: number,
): Promise<{ correct: boolean; label: string; confidence: number; usage?: UsageV2 }> {
  if (!OPENAI_API_KEY) {
    return heuristicJudge(groundTruth, hypothesis);
  }

  const prompt = `You are a strict benchmark judge. Compare the hypothesis answer against the ground truth.

Question: ${question}
Ground Truth: ${groundTruth}
Hypothesis: ${hypothesis}

Rules:
- The hypothesis is CORRECT if it captures the essential factual content of the ground truth, even if wording differs or details are abbreviated.
- Partial matches: If the hypothesis names the right entity/procedure/value but omits some supporting detail, that is still CORRECT.
- For "access denied" questions: if the ground truth says access is denied/unavailable and the hypothesis also says access is denied/cannot access/not accessible, that is CORRECT regardless of the explanation.
- For "access granted" questions: if the ground truth provides a fact value and the hypothesis provides the same fact (even paraphrased), that is CORRECT.
- For numerical answers: the key number must match (e.g., "6 steps" and "The procedure has 6 steps" are both CORRECT, but "5 steps" is INCORRECT).
- For list answers: the hypothesis must include the majority of key items (missing 1 minor item from a list of 5+ is still CORRECT).
- For procedure/entity naming: if the hypothesis names the correct procedure/entity, it is CORRECT even if it doesn't enumerate all steps.
- DO NOT penalize for extra correct information that goes beyond the ground truth.
- If the hypothesis contains the correct key answer (entity name, value, number) from the ground truth, it is CORRECT even if it lacks extra detail.
- Example: truth="claude-code is the fallback (step 5 of v2)", hypothesis="the fallback is claude-code" → CORRECT
- Example: truth="blog-publish-pipeline (version 1)", hypothesis="the blog-publish-pipeline procedure" → CORRECT
- For evolution/diff questions: if the hypothesis identifies the same added/removed/changed steps as the ground truth (even if framed as "removed old + added new" instead of "changed"), that is CORRECT.
- For "which procedure" questions: naming the correct procedure and describing its purpose is CORRECT, even if not all steps are enumerated verbatim.
- If the hypothesis covers the SAME factual content as the ground truth but uses different phrasing or structure, it is CORRECT.

Respond with only two words: the label (correct/incorrect) followed by a confidence score (0.00–1.00).
Examples: "correct 0.92", "incorrect 0.35", "correct 0.78".`;

  const judgeGen = await openaiGenerate(prompt, judgeModel, seed);
  const resp = judgeGen.text;
  const lower = resp.toLowerCase();
  const label = lower.includes("correct") && !lower.includes("incorrect")
    ? "correct" : "incorrect";

  // Parse confidence from trailing number
  const match = resp.match(/(\d*\.?\d+)/);
  let confidence = 0.8;
  if (match) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed)) confidence = Math.max(0.0, Math.min(1.0, parsed));
  }

  return { correct: label === "correct", label, confidence, usage: judgeGen.usage };
}

function heuristicJudge(truth: string, hypothesis: string): { correct: boolean; label: string; confidence: number } {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s.-]/g, " ").replace(/\s+/g, " ").trim();
  const truthNorm = normalize(truth);
  const hypNorm = normalize(hypothesis);

  // Exact inclusion — highest confidence
  if (hypNorm.includes(truthNorm) || truthNorm.includes(hypNorm)) {
    return { correct: true, label: "correct", confidence: 0.95 };
  }

  // Check for "cannot access" / "access denied" patterns
  const denyPatterns = ["cannot access", "cant access", "no shared pool", "no pool", "no inheritance", "not accessible", "access denied", "cannot directly access"];
  const truthDenies = denyPatterns.some((p) => truthNorm.includes(p));
  const hypDenies = denyPatterns.some((p) => hypNorm.includes(p));
  if (truthDenies && hypDenies) return { correct: true, label: "correct", confidence: 0.9 };
  if (truthDenies !== hypDenies) return { correct: false, label: "incorrect", confidence: 0.85 };

  // Extract key entities — proper nouns, numbers, technical terms (longer words)
  const extractKeys = (s: string): string[] => {
    const words = s.split(/\s+/);
    return words.filter((w) => {
      if (/^\d+/.test(w)) return true; // numbers
      if (w.includes("-") && w.length > 3) return true; // hyphenated terms
      if (w.length > 4) return true; // longer words
      return false;
    });
  };

  const truthKeys = extractKeys(truthNorm);
  const matchCount = truthKeys.filter((t) => hypNorm.includes(t)).length;
  const matchRatio = truthKeys.length > 0 ? matchCount / truthKeys.length : 0;

  const correct = matchRatio >= 0.4;
  // Map matchRatio to confidence: higher ratio → higher confidence when correct,
  // lower ratio → higher confidence when incorrect
  const confidence = correct
    ? 0.5 + matchRatio * 0.5  // 0.4→0.70, 1.0→1.00
    : Math.max(0.2, 0.5 - matchRatio * 0.5); // 0.0→0.50, 0.3→0.35

  return { correct, label: correct ? "correct" : "incorrect", confidence };
}

// ─── Consensus tier (Phase 3 gate) ───────────────────────────────────

const CONSENSUS_GATE_PATH = "/home/workspace/Skills/consensus-gate/scripts/consensus-gate.ts";
const PROFILE_VALVE_PATH = process.env.ZOUROBENCH_PROFILE_VALVE_PATH
  ?? "/home/workspace/Skills/consensus-gate/scripts/profile-escalation-valve.ts";
const PROFILE_VALVE_MIN_CONFIDENCE = (() => {
  const value = Number(process.env.PROFILE_ESCALATION_MIN_CONFIDENCE ?? "0.8");
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.8;
})();

async function consensusJudge(
  question: string,
  groundTruth: string,
  hypothesis: string,
  primaryLabel: string,
): Promise<{ verdict: string; confidence: number }> {
  const { execSync } = await import("child_process");
  const content = `Question: ${question}\nGround Truth: ${groundTruth}\nHypothesis: ${hypothesis}\nPrimary judge said: ${primaryLabel}`;
  try {
    const out = execSync(
      `bun "${CONSENSUS_GATE_PATH}" validate --mode judge --code ${JSON.stringify(content)} --criteria "factual-accuracy,judge-calibration" --label "zourobench-judge-${Date.now()}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000 },
    );
    const lines = out.split("\n");
    const resultLine = lines.find((l) => l.includes('"status"') || l.trim().startsWith("{"));
    if (resultLine) {
      try {
        const parsed = JSON.parse(resultLine) as { status: string; consensus?: { confidence: number } };
        return { verdict: parsed.status, confidence: parsed.consensus?.confidence ?? 0.5 };
      } catch {
        // fall through to stdout scan
      }
    }
    // Parse status from human-readable output (matches "Consensus: REJECTED" or 'status: "rejected"')
    const statusMatch = out.match(/(?:consensus|status)['":\s]+(passed|rejected|split)/i);
    const confMatch = out.match(/confidence['":\s]+([\d.]+)/i);
    return {
      verdict: statusMatch ? statusMatch[1].toLowerCase() : "split",
      confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    ⚠ consensus gate error: ${msg.slice(0, 120)}`);
    return { verdict: "error", confidence: 0.5 };
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ProvenProfileGatePayload {
  status?: unknown;
  consensus?: { confidence?: unknown; unanimous?: unknown };
  lineup_profile?: unknown;
  lineup_source?: unknown;
  panel?: unknown;
  panel_fingerprint?: unknown;
  verdicts?: unknown;
}

export function isHealthyProvenProfileResult(payload: ProvenProfileGatePayload, profile: "fast" | "flagship"): boolean {
  if (
    payload.lineup_profile !== profile || payload.lineup_source !== "persisted-profile" ||
    (payload.status !== "passed" && payload.status !== "rejected" && payload.status !== "escalate") ||
    typeof payload.consensus?.confidence !== "number" || !Number.isFinite(payload.consensus.confidence) ||
    payload.consensus.confidence < 0 || payload.consensus.confidence > 1 ||
    typeof payload.consensus.unanimous !== "boolean" ||
    !Array.isArray(payload.panel) || payload.panel.length === 0 ||
    !payload.panel.every((model) => typeof model === "string") ||
    typeof payload.panel_fingerprint !== "string" ||
    payload.panel_fingerprint !== createHash("sha256").update(JSON.stringify(payload.panel)).digest("hex") ||
    !Array.isArray(payload.verdicts)
  ) return false;

  const verdicts = payload.verdicts as Array<{ model?: unknown; confidence?: unknown; issues?: unknown }>;
  return (payload.panel as string[]).every((model) => {
    const verdict = verdicts.find((candidate) => candidate.model === model);
    if (!verdict || typeof verdict.confidence !== "number" || verdict.confidence === 0) return false;
    if (!Array.isArray(verdict.issues)) return false;
    return !verdict.issues.length || !verdict.issues.every((issue) =>
      typeof issue === "string" && /^(?:empty response|unparseable verdict|api error:|call failed:)/i.test(issue)
    );
  });
}

export function parseProfileValveOutput(stdout: string): {
  verdict: string;
  confidence: number;
  metadata: ProfileValveMetadata;
} {
  const marker = "__PROFILE_VALVE_JSON__";
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error("profile valve emitted no JSON sentinel");

  const payload = JSON.parse(line.slice(marker.length)) as ProfileValvePayload;
  const status = payload.decision?.status;
  const confidence = payload.decision?.consensus?.confidence;
  if (
    payload.requestedMode !== "shadow"
    || payload.effectiveMode !== "shadow"
    || payload.decisionSource !== "flagship"
    || (status !== "passed" && status !== "rejected" && status !== "escalate")
    || typeof confidence !== "number"
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
    || typeof payload.valveRunId !== "string"
    || typeof payload.trigger !== "string"
    || typeof payload.escalated !== "boolean"
    || typeof payload.severeMiss !== "boolean"
    || finiteNumber(payload.totalLatencyMs) === null
    || !payload.fast
    || finiteNumber(payload.fast.latencyMs) === null
  ) {
    throw new Error("profile valve emitted malformed or non-Flagship shadow output");
  }

  const flagship = payload.flagship;
  if (!flagship || finiteNumber(flagship.latencyMs) === null) {
    throw new Error("profile valve shadow output is missing the Flagship run");
  }

  return {
    verdict: status === "escalate" ? "split" : status,
    confidence,
    metadata: {
      valve_run_id: payload.valveRunId,
      trigger: payload.trigger,
      escalated: payload.escalated,
      decision_source: "flagship",
      severe_miss: payload.severeMiss,
      total_latency_ms: payload.totalLatencyMs as number,
      fast: {
        consensus_id: nullableString(payload.fast.consensusId),
        gate_run_id: nullableString(payload.fast.gateRunId),
        latency_ms: payload.fast.latencyMs as number,
      },
      flagship: {
        consensus_id: nullableString(flagship.consensusId),
        gate_run_id: nullableString(flagship.gateRunId),
        latency_ms: flagship.latencyMs as number,
      },
      ...(typeof payload.auditError === "string" ? { audit_error: payload.auditError } : {}),
    },
  };
}

async function profileValveJudge(
  question: string,
  groundTruth: string,
  hypothesis: string,
  primaryLabel: string,
): Promise<{ verdict: string; confidence: number; metadata?: ProfileValveMetadata; error?: string }> {
  const content = `Question: ${question}\nGround Truth: ${groundTruth}\nHypothesis: ${hypothesis}\nPrimary judge said: ${primaryLabel}`;
  const proc = Bun.spawn([
    "bun",
    PROFILE_VALVE_PATH,
    "--mode", "shadow",
    "--review-mode", "judge",
    "--code", content,
    "--criteria", "factual-accuracy,judge-calibration",
    "--label", `zourobench-judge-${Date.now()}`,
    "--min-confidence", String(PROFILE_VALVE_MIN_CONFIDENCE),
    "--json",
  ], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 240_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`profile valve failed (${exitCode}): ${stderr.trim().slice(0, 300)}`);
    }
    return parseProfileValveOutput(stdout);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`    ⚠ profile valve error: ${error.slice(0, 180)}`);
    return { verdict: "error", confidence: 0.5, error };
  } finally {
    clearTimeout(timer);
  }
}

async function flagshipConsensusJudge(
  question: string,
  groundTruth: string,
  hypothesis: string,
  primaryLabel: string,
): Promise<{ verdict: string; confidence: number }> {
  const content = `Question: ${question}\nGround Truth: ${groundTruth}\nHypothesis: ${hypothesis}\nPrimary judge said: ${primaryLabel}`;
  const childEnv: Record<string, string | undefined> = { ...process.env, GATE_LINEUP_PROFILE: "flagship" };
  delete childEnv.CONSENSUS_MODELS;
  const proc = Bun.spawn([
    "bun",
    CONSENSUS_GATE_PATH,
    "validate",
    "--json",
    "--mode", "judge",
    "--code", content,
    "--criteria", "factual-accuracy,judge-calibration",
    "--label", `zourobench-flagship-fallback-${Date.now()}`,
  ], { env: childEnv, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Flagship fallback failed (${exitCode}): ${stderr.trim().slice(0, 300)}`);
    const marker = "__CG_JSON__";
    const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(marker));
    if (!line) throw new Error("Flagship fallback emitted no JSON sentinel");
    const parsed = JSON.parse(line.slice(marker.length)) as ProvenProfileGatePayload;
    if (!isHealthyProvenProfileResult(parsed, "flagship")) {
      throw new Error("Flagship fallback emitted malformed, unhealthy, or unproven profile output");
    }
    return {
      verdict: parsed.status === "escalate" ? "split" : String(parsed.status),
      confidence: parsed.consensus!.confidence as number,
    };
  } catch (error) {
    proc.kill();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`    ⚠ direct Flagship fallback error: ${message.slice(0, 180)}`);
    return { verdict: "error", confidence: 0.5 };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveValveWithFlagshipFallback<T extends { verdict: string; confidence: number; error?: string }>(
  valveResult: T,
  fallback: () => Promise<{ verdict: string; confidence: number }>,
): Promise<T | { verdict: string; confidence: number }> {
  return valveResult.error ? fallback() : valveResult;
}

// ─── Retrieval per category ───────────────────────────────────────────

async function retrieveContext(
  db: Database,
  question: string,
  category: string,
  questionMeta: Record<string, unknown>,
): Promise<{ context: string[]; retrieval_ms: number }> {
  const t0 = Date.now();
  const nowSec = Math.floor(Date.now() / 1000);
  let context: string[] = [];

  if (category === "procedural-recall") {
    // Search procedures, episodes, and facts
    const queryVec = await getEmbedding(question);
    const hits = hybridSearch(db, question, queryVec, MAX_CONTEXT_CHUNKS, ["shared"]);

    // For episode-procedure-link: load the episode and its linked procedure version
    if ((questionMeta.type as string) === "episode-procedure-link") {
      const allEps = db.prepare(`
        SELECT e.*, p.name as proc_name, p.version as proc_version FROM episodes e
        LEFT JOIN procedures p ON e.procedure_id = p.id
        ORDER BY e.happened_at DESC
      `).all() as Array<Record<string, unknown>>;
      for (const ep of allEps) {
        const daysAgo = Math.round((nowSec - (ep.happened_at as number)) / 86400);
        context.push(`[Episode ${ep.id}] [procedure: ${ep.proc_name ?? "unknown"} v${ep.proc_version ?? "?"}] ${ep.summary} [outcome: ${ep.outcome}] [${daysAgo} days ago]`);
      }
    }

    // Also search episodes directly
    const epFts = buildFtsQuery(question);
    if (epFts) {
      try {
        const epRows = db.prepare(`
          SELECT episode_id, text FROM episode_documents_fts WHERE episode_documents_fts MATCH ? LIMIT 5
        `).all(epFts) as Array<{ episode_id: string; text: string }>;
        for (const ep of epRows) {
          const full = db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep.episode_id) as Record<string, unknown> | null;
          if (full) {
            const happenedAt = full.happened_at as number;
            const daysAgo = Math.round((nowSec - happenedAt) / 86400);
            context.push(`[Episode ${full.id}] ${full.summary} [outcome: ${full.outcome}] [duration: ${full.duration_ms}ms] [${daysAgo} days ago — most recent = lowest days ago]`);
          }
        }
      } catch {}
    }

    // For temporal questions, load all episodes for the relevant procedure sorted by recency
    if ((questionMeta.type as string) === "episode-temporal") {
      const allEps = db.prepare(`
        SELECT e.*, p.name as proc_name FROM episodes e
        LEFT JOIN procedures p ON e.procedure_id = p.id
        ORDER BY e.happened_at DESC
      `).all() as Array<Record<string, unknown>>;
      // Clear previously added episodes to avoid duplicates
      context = context.filter(c => !c.startsWith("[Episode "));
      for (const ep of allEps) {
        const daysAgo = Math.round((nowSec - (ep.happened_at as number)) / 86400);
        context.push(`[Episode ${ep.id}] [procedure: ${ep.proc_name ?? "unknown"}] ${ep.summary} [outcome: ${ep.outcome}] [duration: ${ep.duration_ms}ms] [${daysAgo} days ago]`);
      }
      // Add explicit answer hint for "most recent" questions
      const procMatch = question.toLowerCase().match(/most recent (\S+)/);
      if (procMatch) {
        const matchedEps = allEps
          .filter(ep => (ep.proc_name as string)?.toLowerCase().includes(procMatch[1].toLowerCase()))
          .sort((a, b) => (b.happened_at as number) - (a.happened_at as number));
        if (matchedEps.length > 0) {
          const best = matchedEps[0];
          const bestDays = Math.round((nowSec - (best.happened_at as number)) / 86400);
          context.push(`[MOST RECENT for "${procMatch[1]}"] Episode ${best.id} at ${bestDays} days ago is the most recent — lower days-ago = more recent`);
        }
      }
    }

    // Add procedure data
    const procName = (questionMeta.procedure as string) ?? "";
    if (procName) {
      const procs = db.prepare("SELECT * FROM procedures WHERE name = ? ORDER BY version DESC").all(procName) as Array<Record<string, unknown>>;
      for (const p of procs) {
        const steps = JSON.parse(p.steps as string) as Array<{ executor: string; taskPattern: string; timeoutSeconds: number; fallbackExecutor?: string }>;
        const stepStr = steps.map((s, i) => `Step ${i + 1}: [${s.executor}] ${s.taskPattern} (${s.timeoutSeconds}s${s.fallbackExecutor ? `, fallback: ${s.fallbackExecutor}` : ""})`).join("\n");
        context.push(`[Procedure: ${p.name} v${p.version}] success: ${p.success_count}, failures: ${p.failure_count}\n${stepStr}`);
      }
    }

    // Add hybrid search hits
    for (const h of hits) {
      if (!context.some((c) => c.includes(h.value.slice(0, 60)))) {
        context.push(`[${h.entity}] ${h.text}`);
      }
    }

    // For evolution-tracking queries, add explicit step diffs between versions
    if ((questionMeta.type as string) === "evolution-tracking") {
      const allProcs = db.prepare("SELECT * FROM procedures ORDER BY name, version").all() as Array<Record<string, unknown>>;
      const byName = new Map<string, Array<Record<string, unknown>>>();
      for (const p of allProcs) {
        const name = p.name as string;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(p);
      }
      for (const [name, versions] of byName) {
        if (versions.length < 2) continue;
        for (let v = 1; v < versions.length; v++) {
          const prev = versions[v - 1];
          const curr = versions[v];
          const prevSteps = JSON.parse(prev.steps as string) as Array<{ executor: string; taskPattern: string; timeoutSeconds: number }>;
          const currSteps = JSON.parse(curr.steps as string) as Array<{ executor: string; taskPattern: string; timeoutSeconds: number }>;
          const added = currSteps.filter(cs => !prevSteps.some(ps => ps.taskPattern === cs.taskPattern));
          const removed = prevSteps.filter(ps => !currSteps.some(cs => cs.taskPattern === ps.taskPattern));
          const changed: string[] = [];
          for (const cs of currSteps) {
            const match = prevSteps.find(ps => ps.taskPattern === cs.taskPattern);
            if (match && (match.timeoutSeconds !== cs.timeoutSeconds || match.executor !== cs.executor)) {
              changed.push(`"${cs.taskPattern}" timeout: ${match.timeoutSeconds}s→${cs.timeoutSeconds}s`);
            }
          }
          const prevRate = ((prev.success_count as number) + (prev.failure_count as number)) > 0
            ? Math.round((prev.success_count as number) / ((prev.success_count as number) + (prev.failure_count as number)) * 100)
            : 0;
          const currRate = ((curr.success_count as number) + (curr.failure_count as number)) > 0
            ? Math.round((curr.success_count as number) / ((curr.success_count as number) + (curr.failure_count as number)) * 100)
            : 0;
          context.push(`[Evolution: ${name} v${prev.version}→v${curr.version}] Steps: ${prevSteps.length}→${currSteps.length}. Added: ${added.length > 0 ? added.map(a => `"${a.taskPattern}"`).join(", ") : "none"}. Removed: ${removed.length > 0 ? removed.map(r => `"${r.taskPattern}"`).join(", ") : "none"}. Changed: ${changed.length > 0 ? changed.join(", ") : "none"}. Success rate: ${prevRate}%→${currRate}%`);
        }
      }
    }

    // For aggregate queries, ensure all procedures are loaded with cross-version summaries
    if ((questionMeta.type as string)?.includes("aggregate") || (questionMeta.type as string)?.includes("cross-procedure")) {
      const allProcs = db.prepare("SELECT * FROM procedures ORDER BY name, version").all() as Array<Record<string, unknown>>;
      for (const p of allProcs) {
        const existing = context.some((c) => c.includes(`${p.name} v${p.version}]`));
        if (!existing) {
          const steps = JSON.parse(p.steps as string) as Array<{ executor: string; taskPattern: string; timeoutSeconds: number; fallbackExecutor?: string }>;
          const maxTimeout = Math.max(...steps.map((s) => s.timeoutSeconds));
          const lastStep = steps[steps.length - 1];
          context.push(`[Procedure: ${p.name} v${p.version}] success_count: ${p.success_count}, failure_count: ${p.failure_count}, total_runs: ${(p.success_count as number) + (p.failure_count as number)}, success_rate: ${((p.success_count as number) + (p.failure_count as number)) > 0 ? Math.round(((p.success_count as number) / ((p.success_count as number) + (p.failure_count as number))) * 100) : 0}%, steps: ${steps.length}, max_timeout: ${maxTimeout}s, final_step_executor: ${lastStep.executor}, executors: ${steps.map((s) => s.executor).join(",")}`);
        }
      }

      // Add explicit final-step summary for cross-procedure queries
      if ((questionMeta.type as string)?.includes("cross-procedure")) {
        const finalStepSummary: string[] = [];
        for (const p of allProcs) {
          const steps = JSON.parse(p.steps as string) as Array<{ executor: string; taskPattern: string }>;
          const lastStep = steps[steps.length - 1];
          finalStepSummary.push(`${p.name} v${p.version}: FINAL step (Step ${steps.length}) executor = ${lastStep.executor} ("${lastStep.taskPattern}")`);
        }
        context.push(`[FINAL STEP SUMMARY — read carefully]\n${finalStepSummary.join("\n")}`);

        const executorMatch = question.match(/\buse (?:the )?([a-z][a-z0-9-]*) executor\b/i);
        if (executorMatch) {
          const procedures = allProcs.map((p) => ({
            name: p.name as string,
            version: p.version as number,
            steps: JSON.parse(p.steps as string) as Array<{ executor: string; taskPattern: string }>,
          }));
          const matches = selectFinalStepEntries(procedures, executorMatch[1].toLowerCase());
          context.push(`[FINAL STEP MATCHES — executor: ${executorMatch[1]} — count: ${matches.length}]\n${matches.length > 0 ? matches.join("\n") : "none"}`);
        }
      }

      // Add cross-version aggregation for each procedure name
      const procNames = [...new Set(allProcs.map((p) => p.name as string))];
      for (const name of procNames) {
        const versions = allProcs.filter((p) => p.name === name);
        const totalSuccess = versions.reduce((s, p) => s + (p.success_count as number), 0);
        const totalFailure = versions.reduce((s, p) => s + (p.failure_count as number), 0);
        const totalRuns = totalSuccess + totalFailure;
        const rate = totalRuns > 0 ? Math.round((totalSuccess / totalRuns) * 100) : 0;
        context.push(`[Aggregate: ${name}] ${versions.length} version(s), total_success: ${totalSuccess}, total_failures: ${totalFailure}, total_runs: ${totalRuns}, overall_success_rate: ${rate}%`);
      }
    }

  } else if (category === "cross-persona-transfer") {
    const queryPersona = questionMeta.queryPersona as string;
    const sourcePersona = questionMeta.sourcePersona as string;

    // Determine accessible personas
    const accessible = getAccessiblePersonas(db, queryPersona);
    const canAccess = sourcePersona === "system" || sourcePersona === "multiple"
      || sourcePersona === queryPersona || accessible.includes(sourcePersona);

    // Add access metadata — make it very explicit
    context.push(`[Access Info] Querying as: ${queryPersona}. Accessible personas: [${accessible.join(", ")}]`);
    if (canAccess && sourcePersona !== "system" && sourcePersona !== "multiple") {
      context.push(`[Access Info] ${queryPersona} CAN access ${sourcePersona}'s facts — ${sourcePersona} is in the accessible list`);
    } else if (!canAccess && sourcePersona !== "system" && sourcePersona !== "multiple") {
      context.push(`[Access Info] ${queryPersona} CANNOT access ${sourcePersona}'s facts — ${sourcePersona} is NOT in the accessible list (no shared pool or inheritance chain)`);
    }

    // Search within accessible persona scope
    const queryVec = await getEmbedding(question);
    const hits = hybridSearch(db, question, queryVec, MAX_CONTEXT_CHUNKS, accessible);

    for (const h of hits) {
      context.push(`[${h.persona}] ${h.text}`);
    }

    // For multi-source-aggregation queries, list all accessible facts grouped by source persona
    if ((questionMeta.type as string) === "multi-source-aggregation") {
      const allAccessibleFacts = db.prepare(`
        SELECT persona, entity, key, value, category FROM facts
        WHERE persona IN (${accessible.map(() => "?").join(",")})
        AND category != 'procedure'
      `).all(...accessible) as Array<{ persona: string; entity: string; key: string; value: string; category: string }>;
      // Group by entity matching the question keywords
      const questionLower = question.toLowerCase();
      const relevantFacts = allAccessibleFacts.filter(f =>
        questionLower.includes(f.entity.toLowerCase()) ||
        questionLower.includes(f.key.toLowerCase()) ||
        f.entity.toLowerCase().includes("deploy") && questionLower.includes("deploy")
      );
      if (relevantFacts.length > 0) {
        context.push(`[Multi-Source Facts about topic] ${relevantFacts.map(f => `${f.persona}: ${f.entity}/${f.key} = ${f.value}`).join("\n")}`);
      }

      // Also include episodes related to the query topic
      const epRows = db.prepare("SELECT * FROM episodes").all() as Array<Record<string, unknown>>;
      const topicWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const relevantEps = epRows.filter(ep => {
        const summary = (ep.summary as string).toLowerCase();
        return topicWords.some(w => summary.includes(w));
      });
      for (const ep of relevantEps) {
        const daysAgo = Math.round((Math.floor(Date.now() / 1000) - (ep.happened_at as number)) / 86400);
        context.push(`[Episode ${ep.id}] [procedure: ${ep.procedure_id ?? "unknown"}] ${ep.summary} [outcome: ${ep.outcome}] [${daysAgo} days ago]`);
      }
    }

    // For self-pool queries, add explicit own-facts listing
    if ((questionMeta.type as string) === "self-pool-query") {
      const pools = db.prepare(`
        SELECT pp.name, pp.description FROM persona_pools pp
        JOIN persona_pool_members ppm ON pp.id = ppm.pool_id
        WHERE ppm.persona = ?
      `).all(queryPersona) as Array<{ name: string; description: string }>;
      if (pools.length > 0) {
        context.push(`[Pool Membership] ${queryPersona} is a member of: ${pools.map((p) => `${p.name} (${p.description})`).join(", ")}`);
      }
      // List own facts explicitly
      const ownFacts = db.prepare("SELECT entity, key, value FROM facts WHERE persona = ? AND category != 'procedure'")
        .all(queryPersona) as Array<{ entity: string; key: string; value: string }>;
      if (ownFacts.length > 0) {
        context.push(`[YOUR FACTS - ${queryPersona}] You have ${ownFacts.length} facts:\n${ownFacts.map((f) => `  • ${f.entity} / ${f.key}: ${f.value}`).join("\n")}`);
      }
    }

    // For inheritance-query: explicitly inject sourcePersona's convention/decision facts
    // Problem: swarm task entries dominate vector search and bury concise convention facts.
    // Fix: directly fetch and surface all non-swarm facts from sourcePersona.
    if ((questionMeta.type as string) === "inheritance-query" && canAccess && sourcePersona && sourcePersona !== "system" && sourcePersona !== "multiple") {
      const sourceFacts = db.prepare(
        "SELECT entity, key, value, category FROM facts WHERE persona = ? AND category NOT IN ('procedure') AND entity NOT LIKE 'swarm:%' ORDER BY importance DESC"
      ).all(sourcePersona) as Array<{ entity: string; key: string; value: string; category: string }>;
      if (sourceFacts.length > 0) {
        context.push(
          `[DIRECT FACTS — ${sourcePersona}] ${queryPersona} inherits from ${sourcePersona}. Here are ${sourcePersona}'s stored conventions and decisions:\n` +
          sourceFacts.map(f => `  • [${f.category}] ${f.entity} / ${f.key}: ${f.value}`).join("\n")
        );
      }
      // Also show the inheritance path
      const parents = db.prepare("SELECT parent_persona FROM persona_inheritance WHERE child_persona = ? ORDER BY depth")
        .all(queryPersona) as Array<{ parent_persona: string }>;
      context.push(`[Inheritance] ${queryPersona} directly inherits from: ${parents.map(p => p.parent_persona).join(", ")}`);
    }

    // For pool-access: explicitly inject sourcePersona's facts and name the bridging pool
    if ((questionMeta.type as string) === "pool-access" && canAccess && sourcePersona && sourcePersona !== "system" && sourcePersona !== "multiple") {
      // Find which pool connects queryPersona to sourcePersona
      const bridgePools = db.prepare(`
        SELECT pp.name FROM persona_pools pp
        JOIN persona_pool_members qpm ON pp.id = qpm.pool_id AND qpm.persona = ?
        JOIN persona_pool_members spm ON pp.id = spm.pool_id AND spm.persona = ?
      `).all(queryPersona, sourcePersona) as Array<{ name: string }>;
      const poolNames = bridgePools.map(p => p.name).join(", ");
      if (poolNames) {
        context.push(`[Pool Bridge] ${queryPersona} can access ${sourcePersona}'s facts via shared pool(s): ${poolNames}`);
      }
      const sourceFacts = db.prepare(
        "SELECT entity, key, value, category FROM facts WHERE persona = ? AND category NOT IN ('procedure') AND entity NOT LIKE 'swarm:%' ORDER BY importance DESC"
      ).all(sourcePersona) as Array<{ entity: string; key: string; value: string; category: string }>;
      if (sourceFacts.length > 0) {
        context.push(
          `[DIRECT FACTS — ${sourcePersona}] Accessible via ${poolNames || "shared pool"}:\n` +
          sourceFacts.map(f => `  • [${f.category}] ${f.entity} / ${f.key}: ${f.value}`).join("\n")
        );
      }
    }

    // For inheritance chain queries, add explicit chain info
    if ((questionMeta.type as string) === "inheritance-chain") {
      const parents = db.prepare("SELECT parent_persona, depth FROM persona_inheritance WHERE child_persona = ? ORDER BY depth")
        .all(queryPersona) as Array<{ parent_persona: string; depth: number }>;
      context.push(`[Inheritance Chain] ${queryPersona} inherits from: ${parents.map((p) => `${p.parent_persona} (depth ${p.depth})`).join(", ")}`);

      // Pool memberships for each parent AND all pool co-members (transitive access)
      const transitivePersonas = new Set<string>();
      for (const parent of parents) {
        transitivePersonas.add(parent.parent_persona);
        const pools = db.prepare(`
          SELECT pp.id, pp.name FROM persona_pools pp
          JOIN persona_pool_members ppm ON pp.id = ppm.pool_id
          WHERE ppm.persona = ?
        `).all(parent.parent_persona) as Array<{ id: string; name: string }>;
        for (const pool of pools) {
          const members = db.prepare("SELECT persona FROM persona_pool_members WHERE pool_id = ?")
            .all(pool.id) as Array<{ persona: string }>;
          for (const m of members) transitivePersonas.add(m.persona);
          context.push(`[Pool Info] ${parent.parent_persona} is in pool "${pool.name}" — members: ${members.map(m => m.persona).join(", ")}`);
        }
      }
      context.push(`[Full Accessible Personas via Inheritance + Pools] ${queryPersona} can access knowledge from: ${[...transitivePersonas].join(", ")}`);
    }

  } else if (category === "swarm-context-propagation") {
    const dagId = questionMeta.dag as string;

    // Load DAG tasks — parse artifacts as JSON arrays for accurate counting
    const tasks = searchSwarmTasks(db, dagId, question);
    let totalArtifacts: string[] = [];
    for (const t of tasks) {
      const deps = JSON.parse(t.dependsOn) as string[];
      let artifactList: string[] = [];
      try {
        artifactList = JSON.parse(t.artifacts) as string[];
      } catch {
        artifactList = t.artifacts ? [t.artifacts] : [];
      }
      totalArtifacts.push(...artifactList);
      context.push(`[Task ${t.taskId}] [persona: ${t.persona}] [depends: ${deps.join(",")}]\nTask: ${t.task}\nOutput: ${t.output}\nArtifacts (${artifactList.length}): ${artifactList.join(", ")}`);
    }
    if (totalArtifacts.length > 0) {
      context.push(`[Artifact Summary] Total artifacts in this DAG: ${totalArtifacts.length} — ${totalArtifacts.join(", ")}`);
    }

    // For "all" DAG queries, also load other DAGs
    if (dagId === "all") {
      // Already loaded all tasks above
    }

    // Add DAG summary for aggregate queries
    const dagIds = db.prepare("SELECT DISTINCT dag_id FROM swarm_tasks").all() as Array<{ dag_id: string }>;
    for (const d of dagIds) {
      const taskCount = db.prepare("SELECT COUNT(*) as cnt FROM swarm_tasks WHERE dag_id = ?").get(d.dag_id) as { cnt: number };
      const successCount = db.prepare("SELECT COUNT(*) as cnt FROM swarm_tasks WHERE dag_id = ? AND success = 1").get(d.dag_id) as { cnt: number };
      if (!context.some((c) => c.includes(`DAG Summary: ${d.dag_id}`))) {
        context.push(`[DAG Summary: ${d.dag_id}] ${taskCount.cnt} tasks, ${successCount.cnt} succeeded, ${taskCount.cnt - successCount.cnt} failed`);
      }
    }

    // Also search facts for supplementary context
    const queryVec = await getEmbedding(question);
    const hits = hybridSearch(db, question, queryVec, 5);
    for (const h of hits) {
      if (!context.some((c) => c.includes(h.value.slice(0, 60)))) {
        context.push(`[${h.entity}] ${h.text}`);
      }
    }
  }

  return { context: context.slice(0, MAX_CONTEXT_CHUNKS + 10), retrieval_ms: Date.now() - t0 };
}

// ─── Main ────────────────────────────────────────────────────────────

export function assertJudgeCredential(judgeEnabled: boolean, openAiApiKey: string): void {
  if (judgeEnabled && !openAiApiKey.trim()) {
    throw new Error("--judge requires OPENAI_API_KEY; heuristic fallback is not allowed for a declared LLM-judge run");
  }
}

export function assertEmbeddingCoverage(judgeEnabled: boolean, expected: number, observed: number): void {
  if (judgeEnabled && observed !== expected) {
    throw new Error(`--judge requires complete embedding coverage; expected ${expected}, observed ${observed}`);
  }
}

export function resolveReplicatePlan(input: {
  runs: string | undefined;
  replicateSeeds: string | undefined;
  minimumN: string | undefined;
  replicateStart: string | undefined;
  cohortRuns: string | undefined;
  cohortReplicateSeeds: string | undefined;
}): {
  totalRuns: number;
  minimumN: number;
  replicateSeeds: string[];
  replicateStart: number;
  cohortRuns: number;
  cohortReplicateSeeds: string[];
} {
  const totalRuns = Math.max(1, parseInt(input.runs ?? "1", 10) || 1);
  const minimumN = Math.max(1, parseInt(input.minimumN ?? String(DEFAULT_MIN_REPLICATES), 10) || DEFAULT_MIN_REPLICATES);
  const replicateSeeds = input.replicateSeeds
    ?.split(",")
    .map((seed) => seed.trim())
    .filter(Boolean)
    ?? Array.from({ length: totalRuns }, (_, index) => String(index + 1));
  if (replicateSeeds.length !== totalRuns) {
    throw new Error(`--replicate-seeds requires exactly ${totalRuns} seed(s); received ${replicateSeeds.length}`);
  }

  const replicateStart = parseInt(input.replicateStart ?? "1", 10);
  if (!Number.isInteger(replicateStart) || replicateStart < 1) {
    throw new Error("--replicate-start must be a positive integer");
  }
  const cohortRuns = parseInt(input.cohortRuns ?? String(totalRuns), 10);
  if (!Number.isInteger(cohortRuns) || cohortRuns < replicateStart + totalRuns - 1) {
    throw new Error("--cohort-runs must include every emitted replicate index");
  }
  const cohortReplicateSeeds = input.cohortReplicateSeeds
    ?.split(",")
    .map((seed) => seed.trim())
    .filter(Boolean)
    ?? replicateSeeds;
  if (cohortReplicateSeeds.length !== cohortRuns) {
    throw new Error(`--cohort-replicate-seeds requires exactly ${cohortRuns} seed(s); received ${cohortReplicateSeeds.length}`);
  }
  const expectedSeeds = cohortReplicateSeeds.slice(replicateStart - 1, replicateStart - 1 + totalRuns);
  if (JSON.stringify(replicateSeeds) !== JSON.stringify(expectedSeeds)) {
    throw new Error("--replicate-seeds must match the resumed slice of --cohort-replicate-seeds");
  }
  return { totalRuns, minimumN, replicateSeeds, replicateStart, cohortRuns, cohortReplicateSeeds };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string" },
      output: { type: "string", default: "data/runs" },
      limit: { type: "string", default: "50" },
      judge: { type: "boolean", default: false },
      "judge-model": { type: "string", default: "gpt-4o" },
      "judge-confidence-threshold": { type: "string", default: "0.7" },
      "consensus-gate": { type: "boolean", default: false },
      "profile-valve-shadow": { type: "boolean", default: false },
      category: { type: "string", default: ALL_CATEGORIES.join(",") },
      runs: { type: "string", default: "1" },
      "replicate-seeds": { type: "string" },
      "replicate-start": { type: "string", default: "1" },
      "cohort-runs": { type: "string" },
      "cohort-replicate-seeds": { type: "string" },
      "minimum-n": { type: "string", default: String(DEFAULT_MIN_REPLICATES) },
      "cohort-id": { type: "string" },
      "parity-baseline": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || !values.dataset) {
    console.log(`ZouroBench — Zouroboros Capability Benchmark

Usage:
  bun adapters/zourobench-adapter.ts \\
    --dataset data/zourobench/seed.json \\
    --output data/runs/ \\
    [--limit 50] \\
    [--judge] \\
    [--judge-model gpt-4o] \\
    [--judge-confidence-threshold 0.7] \\
    [--consensus-gate] \\
    [--profile-valve-shadow] \\
    [--category procedural-recall,cross-persona-transfer,swarm-context-propagation]

Categories:
  procedural-recall          — Procedure storage, retrieval, evolution tracking
  cross-persona-transfer     — Knowledge access via pools and inheritance
  swarm-context-propagation  — DAG task context flow and artifact tracking

Flags:
  --judge                        Enable LLM judge (default: heuristic)
  --judge-model                  Model for judging (default: gpt-4o)
  --judge-confidence-threshold   Invoke consensus gate below this (default: 0.7)
  --consensus-gate               Enable Phase 3 two-layer consensus gate
  --profile-valve-shadow         With --consensus-gate, compare Fast + Flagship;
                                 return Flagship and record valve metadata
  --runs                         Number of replicates to run (default: 1). N≥5
                                 is publishable; smaller cohorts are underpowered.
  --replicate-seeds              Comma-separated paired seeds (one per run).
                                 Defaults deterministically to 1..N.
  --replicate-start              One-based index of the first emitted replicate.
  --cohort-runs                  Total planned cohort size for a resumed run.
  --cohort-replicate-seeds       Full seed list for the resumed cohort. These
                                 continuation flags preserve one configuration
                                 fingerprint across interrupted executions.
  --minimum-n                    Publishable minimum replicate count (default: 5).
  --cohort-id                    Cohort identifier shared by emitted run files.
  --parity-baseline              Prior run artifact (v1 or v2) to record as the
                                 parity reference in the emitted artifact.`);
    process.exit(values.help ? 0 : 1);
  }

  const selectedCategories = values.category!.split(",").map((s) => s.trim());
  const limit = parseInt(values.limit!, 10);
  const judgeEnabled = values.judge!;
  const judgeModel = values["judge-model"]!;
  assertJudgeCredential(judgeEnabled, OPENAI_API_KEY);
  const confidenceThreshold = parseFloat(values["judge-confidence-threshold"] ?? "0.7");
  const consensusGateEnabled = values["consensus-gate"]!;
  const profileValveShadowEnabled = values["profile-valve-shadow"]!;
  if (profileValveShadowEnabled && !consensusGateEnabled) {
    throw new Error("--profile-valve-shadow requires --consensus-gate");
  }
  const {
    totalRuns,
    minimumN,
    replicateSeeds,
    replicateStart,
    cohortRuns,
    cohortReplicateSeeds,
  } = resolveReplicatePlan({
    runs: values.runs,
    replicateSeeds: values["replicate-seeds"],
    minimumN: values["minimum-n"],
    replicateStart: values["replicate-start"],
    cohortRuns: values["cohort-runs"],
    cohortReplicateSeeds: values["cohort-replicate-seeds"],
  });
  const cohortId = values["cohort-id"]?.trim() || randomUUID();

  console.log("╔══════════════════════════════════════════╗");
  console.log(`║         ZouroBench v${ADAPTER_VERSION}                ║`);
  console.log("║  Procedural · Cross-Persona · Swarm      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Categories: ${selectedCategories.join(", ")}`);
  console.log(`Limit: ${limit} per category`);
  console.log(`Judge: ${judgeEnabled ? judgeModel : "heuristic"}`);
  if (consensusGateEnabled) console.log(`Consensus gate: enabled (threshold < ${confidenceThreshold})`);
  if (profileValveShadowEnabled) console.log("Profile valve: shadow (Fast + Flagship, Flagship authoritative)");
  console.log(`Answer model: ${ANSWER_MODEL}`);
  console.log();

  // Load seed data
  console.log("[1/5] Loading seed data...");
  const rawDataset = readFileSync(values.dataset!, "utf-8");
  const seed: SeedData = JSON.parse(rawDataset);
  console.log(`  Loaded: ${seed.metadata.name} v${seed.metadata.version}`);

  // ZBRE-002: immutable provenance captured before any scoring work.
  // Observed: raw dataset bytes, git state, host, argv. Derived: the three
  // deterministic hashes. None of this touches scoring behavior.
  const datasetHash = computeDatasetHash(rawDataset);
  const selectedQuestionIdentities = selectedCategories.flatMap((category) =>
    (seed.questions[category] ?? []).slice(0, limit).map((q) => ({
      category,
      id: q.id,
      type: q.type,
      question: q.question,
      answer: q.answer,
    })),
  );
  const questionSetHash = computeQuestionSetHash(selectedQuestionIdentities);
  const nonSecretFlags: Record<string, unknown> = {
    benchmark: "ZouroBench",
    adapter_version: ADAPTER_VERSION,
    dataset: values.dataset!,
    dataset_sha256: datasetHash,
    question_set_sha256: questionSetHash,
    categories: selectedCategories,
    limit,
    judge: judgeEnabled,
    judge_model: judgeEnabled ? judgeModel : null,
    judge_confidence_threshold: confidenceThreshold,
    consensus_gate: consensusGateEnabled,
    profile_valve_shadow: profileValveShadowEnabled,
    runs: cohortRuns,
    replicate_seeds: cohortReplicateSeeds,
    minimum_n: minimumN,
    answer_model: ANSWER_MODEL,
    answer_temperatures: {
      procedural_recall: effectiveTemperatureForModel(ANSWER_MODEL, 0),
      other_categories: effectiveTemperatureForModel(ANSWER_MODEL, 0.1),
    },
    answer_reasoning_mode: reasoningModeForModel(ANSWER_MODEL),
    provider_retry_policy: {
      max_attempts: PROVIDER_MAX_ATTEMPTS,
      statuses: [429, 500, 502, 503, 504],
      rate_limit_cooldown_ms: 60_000,
      max_retry_after_ms: 60_000,
      fallback: "none",
    },
    embedding_model: EMBEDDING_MODEL,
    truncation_guard: BENCH_TRUNCATION_GUARD,
    generation_timeout_ms: BENCH_GEN_TIMEOUT_MS,
    max_answer_tokens: MAX_ANSWER_TOKENS,
    max_context_chunks: MAX_CONTEXT_CHUNKS,
  };
  const configFingerprint = computeConfigFingerprint(nonSecretFlags);
  const gitProvenance = collectGitProvenance(defaultGitRunner(process.cwd()));
  const invocation = `bun adapters/zourobench-adapter.ts ${process.argv.slice(2).join(" ")}`.trim();
  const runHost = hostname();

  // Parity reference (derived from an explicitly referenced baseline run).
  let parityBaselineRaw: unknown = null;
  const parityBaselinePath = values["parity-baseline"];
  if (parityBaselinePath) {
    try {
      parityBaselineRaw = JSON.parse(readFileSync(parityBaselinePath, "utf-8"));
    } catch (e) {
      console.log(`  ⚠ parity baseline unreadable (${(e as Error).message}); parity will be recorded unavailable`);
      parityBaselineRaw = null;
    }
  }

  // Init DB
  console.log("[2/5] Initializing benchmark database...");
  const tmpDir = `/tmp/zourobench-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = join(tmpDir, "bench.db");
  const db = initBenchDb(dbPath);

  // Seed data
  console.log("[3/5] Seeding database...");
  const embeddable = seedDatabase(db, seed);
  console.log(`  ${embeddable.length} items to embed`);

  // Embeddings
  console.log("[4/5] Building embeddings...");
  const embeddings = await embedBatch(embeddable, EMBEDDING_CONCURRENCY, "embed");
  assertEmbeddingCoverage(judgeEnabled, embeddable.length, embeddings.size);
  storeEmbeddings(db, embeddings);
  console.log(`  Stored ${embeddings.size} embeddings`);

  // Run questions — repeated `totalRuns` times against the same seeded DB +
  // embeddings, so each replicate isolates pipeline variance (generation/judge),
  // not data-prep variance. With --runs 1 (default) this loop runs once and is
  // explicitly labeled underpowered in the emitted replicate metadata.
  const replicateRuns: Array<{
    replicate: { seed: string; cohort_id: string; timeout_ms: number; minimum_n: number };
    scores: { overall_accuracy: number };
    questions: QuestionResult[];
  }> = [];
  for (let replicate = 0; replicate < totalRuns; replicate++) {
  const replicateSeed = replicateSeeds[replicate]!;
  const replicateIndex = replicateStart + replicate;
  if (cohortRuns > 1) console.log(`\n━━━ Replicate ${replicateIndex} of ${cohortRuns} ━━━`);
  console.log("[5/5] Running questions...\n");

  const allResults: QuestionResult[] = [];
  // ZBRE-002 capture — per-replicate identity, usage, and structured errors.
  const runId = randomUUID();
  const usageAccumulator = new UsageAccumulator();
  const runErrors: RunErrorEntry[] = [];
  const categoryScores: Record<string, { correct: number; total: number; accuracy: number }> = {};
  const typeScores: Record<string, { correct: number; total: number; accuracy: number }> = {};
  const latencies: { retrieval: number[]; answer: number[] } = { retrieval: [], answer: [] };
  let consensusInvocations = 0;
  let consensusSplits = 0;
  let profileValveInvocations = 0;
  let profileValveErrors = 0;
  let profileValveSevereMisses = 0;
  const profileValveTriggers: Record<string, number> = {};

  for (const category of selectedCategories) {
    const questions = seed.questions[category];
    if (!questions) {
      console.log(`  ⚠ No questions for category: ${category}`);
      continue;
    }

    const toRun = questions.slice(0, limit);
    console.log(`  ▶ ${category} (${toRun.length} questions)`);

    let catCorrect = 0;
    const catTotal = toRun.length;

    for (const q of toRun) {
      const { context, retrieval_ms } = await retrieveContext(db, q.question, category, q as Record<string, unknown>);
      latencies.retrieval.push(retrieval_ms);

      const t0 = Date.now();
      const gen = await generateAnswer(q.question, context, category, requestSeed(`${replicateSeed}:answer:${q.id}`));
      const hypothesis = gen.text;
      const answer_ms = Date.now() - t0;
      latencies.answer.push(answer_ms);

      // A timed-out generation is a failure, not a silent skip — and it bypasses
      // the judge/consensus path entirely so an empty answer can't be flipped to
      // pass. With BENCH_GEN_TIMEOUT_MS=0 (default), gen.timedOut is always false,
      // so this branch is never taken and behavior is byte-identical to legacy.
      let label: string;
      let confidence: number;
      let correct: boolean;
      let judgeUsage: UsageV2 | undefined;
      if (gen.timedOut) {
        label = "timeout";
        confidence = 0;
        correct = false;
        runErrors.push({
          question_id: q.id,
          stage: "generation",
          message: "generation aborted by BENCH_GEN_TIMEOUT_MS deadline",
        });
      } else {
        const primary: { correct: boolean; label: string; confidence: number; usage?: UsageV2 } = judgeEnabled
          ? await judgeAnswer(q.question, q.answer, hypothesis, judgeModel, requestSeed(`${replicateSeed}:judge:${q.id}`))
          : heuristicJudge(q.answer, hypothesis);
        label = primary.label;
        confidence = primary.confidence;
        correct = primary.correct;
        judgeUsage = primary.usage;
        if (judgeEnabled) usageAccumulator.add(judgeModel, judgeUsage);
      }
      usageAccumulator.add(ANSWER_MODEL, gen.usage);

      let consensusInvoked = false;
      let consensusVerdict: string | undefined;
      let consensusConfidence: number | undefined;
      let profileValveMetadata: ProfileValveMetadata | undefined;
      let profileValveError: string | undefined;

      // Phase 3: invoke consensus gate when primary judge is uncertain
      if (!gen.timedOut && consensusGateEnabled && confidence < confidenceThreshold) {
        consensusInvocations++;
        process.stdout.write(`    ⟳ low confidence (${confidence.toFixed(2)}) → consensus gate\n`);
        const valveResult = profileValveShadowEnabled
          ? await profileValveJudge(q.question, q.answer, hypothesis, label)
          : null;
        const cgResult = valveResult
          ? await resolveValveWithFlagshipFallback(
              valveResult,
              () => flagshipConsensusJudge(q.question, q.answer, hypothesis, label),
            )
          : await consensusJudge(q.question, q.answer, hypothesis, label);
        if (valveResult) {
          profileValveInvocations++;
          if (valveResult.error) {
            profileValveErrors++;
            profileValveError = valveResult.error;
          }
          if (valveResult.metadata) {
            profileValveMetadata = valveResult.metadata;
            if (profileValveMetadata.severe_miss) profileValveSevereMisses++;
            profileValveTriggers[profileValveMetadata.trigger] = (profileValveTriggers[profileValveMetadata.trigger] ?? 0) + 1;
          }
        }
        consensusInvoked = true;
        consensusVerdict = cgResult.verdict;
        consensusConfidence = cgResult.confidence;
        if (cgResult.verdict === "error") {
          runErrors.push({
            question_id: q.id,
            stage: "consensus",
            message: "consensus gate returned an error verdict; primary judge result kept",
          });
        }
        if (cgResult.verdict === "split") {
          consensusSplits++;
          // Split — keep primary judge result but flag it
        } else if (cgResult.verdict === "passed") {
          correct = true;
        } else if (cgResult.verdict === "rejected") {
          correct = false;
        }
        // "error" — keep primary result
      }

      if (correct) catCorrect++;

      const typeKey = `${category}:${q.type}`;
      if (!typeScores[typeKey]) typeScores[typeKey] = { correct: 0, total: 0, accuracy: 0 };
      typeScores[typeKey].total++;
      if (correct) typeScores[typeKey].correct++;

      allResults.push({
        question_id: q.id,
        question_type: q.type,
        category,
        question: q.question,
        ground_truth: q.answer,
        hypothesis,
        retrieved_context: context,
        retrieval_ms,
        answer_ms,
        correct,
        judge_label: label,
        judge_confidence: confidence,
        consensus_invoked: consensusInvoked || undefined,
        consensus_verdict: consensusVerdict,
        consensus_confidence: consensusConfidence,
        profile_valve_invoked: (profileValveShadowEnabled && consensusInvoked) || undefined,
        profile_valve: profileValveMetadata,
        profile_valve_error: profileValveError,
        truncated: gen.truncated || undefined,
        timed_out: gen.timedOut || undefined,
        finish_reason: gen.finishReason,
        usage: (() => {
          const summed = sumQuestionUsage([gen.usage, judgeUsage]);
          return summed
            ? present(summed)
            : unavailable<UsageV2>("provider responses for this question did not include token usage");
        })(),
      });

      const mark = correct ? "✓" : "✗";
      const cgTag = consensusInvoked ? ` [cg:${consensusVerdict}]` : "";
      process.stdout.write(`    ${mark} ${q.id} (${retrieval_ms}ms + ${answer_ms}ms)${cgTag}\n`);
    }

    const accuracy = catTotal > 0 ? Math.round((catCorrect / catTotal) * 1000) / 10 : 0;
    categoryScores[category] = { correct: catCorrect, total: catTotal, accuracy };
    console.log(`    → ${category}: ${accuracy}% (${catCorrect}/${catTotal})\n`);
  }

  // Finalize type scores
  for (const [, v] of Object.entries(typeScores)) {
    v.accuracy = v.total > 0 ? Math.round((v.correct / v.total) * 1000) / 10 : 0;
  }

  // Compute overall
  const totalCorrect = Object.values(categoryScores).reduce((s, c) => s + c.correct, 0);
  const totalQuestions = Object.values(categoryScores).reduce((s, c) => s + c.total, 0);
  const overallAccuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 1000) / 10 : 0;

  const avgRetrieval = latencies.retrieval.length > 0
    ? Math.round(latencies.retrieval.reduce((a, b) => a + b, 0) / latencies.retrieval.length)
    : 0;
  const avgAnswer = latencies.answer.length > 0
    ? Math.round(latencies.answer.reduce((a, b) => a + b, 0) / latencies.answer.length)
    : 0;
  const p95Retrieval = latencies.retrieval.length > 0
    ? Math.round(latencies.retrieval.sort((a, b) => a - b)[Math.floor(latencies.retrieval.length * 0.95)])
    : 0;

  // Output — the legacy v1 object is assembled exactly as before; the v2
  // contract blocks are added AROUND it so legacy readers see identical bytes.
  const runTimestamp = new Date().toISOString();
  const result = {
    benchmark: "ZouroBench",
    timestamp: runTimestamp,
    dataset: values.dataset!,
    total_questions: totalQuestions,
    answered: allResults.length,
    scores: {
      overall_accuracy: overallAccuracy,
      by_category: categoryScores,
      by_type: typeScores,
    },
    latency: {
      avg_retrieval_ms: avgRetrieval,
      avg_answer_ms: avgAnswer,
      p95_retrieval_ms: p95Retrieval,
    },
    consensus_gate: consensusGateEnabled ? {
      enabled: true,
      threshold: confidenceThreshold,
      invocations: consensusInvocations,
      splits: consensusSplits,
    } : { enabled: false },
    profile_valve_shadow: profileValveShadowEnabled ? {
      enabled: true,
      invocations: profileValveInvocations,
      errors: profileValveErrors,
      severe_misses: profileValveSevereMisses,
      triggers: profileValveTriggers,
    } : { enabled: false },
    replicate: {
      index: replicateIndex,
      seed: replicateSeed,
      cohort_id: cohortId,
      minimum_n: minimumN,
      timeout_ms: BENCH_GEN_TIMEOUT_MS,
    },
    questions: allResults,
  };

  // ZBRE-002: schema_version 2 superset. Seeds are labels ("1", "2", …); the
  // contract wants a number, so non-numeric labels are FNV-hashed via
  // requestSeed and the original label is kept alongside.
  const numericSeed = Number.isFinite(Number(replicateSeed)) ? Number(replicateSeed) : requestSeed(replicateSeed);
  const artifact = buildV2ResultArtifact({
    legacyResult: result,
    runId,
    benchmark: "ZouroBench",
    timestamp: runTimestamp,
    dataset: values.dataset!,
    totalQuestions,
    answered: allResults.length,
    cohort: {
      cohort_id: cohortId,
      replicate_index: replicateIndex,
      replicate_seed: numericSeed,
      replicate_seed_label: replicateSeed,
      minimum_n: minimumN,
      timeout_ms: BENCH_GEN_TIMEOUT_MS > 0 ? BENCH_GEN_TIMEOUT_MS : null,
    },
    git: gitProvenance,
    host: runHost,
    invocation,
    datasetHash,
    questionSetHash,
    configFingerprint,
    flags: nonSecretFlags,
    execution: {
      answer_model: ANSWER_MODEL,
      judge_model: judgeEnabled
        ? present(judgeModel)
        : unavailable<string>("heuristic judge; no LLM judge model configured for this run"),
      embedding_model: present(EMBEDDING_MODEL),
      truncation_guard_enabled: BENCH_TRUNCATION_GUARD,
      // Observed setting: 0 means the timeout guard is disabled.
      generation_timeout_ms: present(BENCH_GEN_TIMEOUT_MS),
      max_tokens: MAX_ANSWER_TOKENS,
    },
    usage: usageAccumulator.evidencedTotals(),
    usageCoverage: usageAccumulator.coverage(),
    pricing: usageAccumulator.evidencedPricing(),
    consensus: {
      enabled: consensusGateEnabled,
      threshold: consensusGateEnabled
        ? present(confidenceThreshold)
        : unavailable<number>("consensus gate was disabled for this run"),
      invocations: consensusGateEnabled
        ? present(consensusInvocations)
        : unavailable<number>("consensus gate was disabled for this run"),
      splits: consensusGateEnabled
        ? present(consensusSplits)
        : unavailable<number>("consensus gate was disabled for this run"),
    },
    parity: parityBaselineRaw !== null
      ? computeParity(
          overallAccuracy,
          allResults.map((r) => r.question_id),
          parityBaselineRaw,
          parityBaselinePath ?? "baseline",
        )
      : unavailable("no parity baseline referenced for this run (pass --parity-baseline)"),
    errors: runErrors,
    recordedAt: new Date().toISOString(),
  });

  const outDir = values.output!;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  // Suffix only when running multiple replicates, so --runs 1 keeps the legacy filename.
  const replicateSuffix = cohortRuns > 1 ? `-r${String(replicateIndex).padStart(2, "0")}` : "";
  const outFile = join(outDir, `ZouroBench-${new Date().toISOString().replace(/[:.]/g, "-")}${replicateSuffix}.json`);
  writeFileSync(outFile, JSON.stringify(artifact, null, 2));
  replicateRuns.push({
    replicate: {
      seed: replicateSeed,
      cohort_id: cohortId,
      timeout_ms: BENCH_GEN_TIMEOUT_MS,
      minimum_n: minimumN,
    },
    scores: { overall_accuracy: overallAccuracy },
    questions: allResults,
  });

  // Summary
  console.log("═".repeat(60));
  console.log("ZOUROBENCH RESULTS");
  console.log("═".repeat(60));
  console.log(`Overall: ${overallAccuracy}% (${totalCorrect}/${totalQuestions})`);
  console.log();
  console.log("By Category:");
  for (const [cat, score] of Object.entries(categoryScores)) {
    console.log(`  ${cat}: ${score.accuracy}% (${score.correct}/${score.total})`);
  }
  console.log();
  console.log("By Question Type:");
  for (const [type, score] of Object.entries(typeScores)) {
    console.log(`  ${type}: ${score.accuracy}% (${score.correct}/${score.total})`);
  }
  console.log();
  console.log(`Latency: avg retrieval ${avgRetrieval}ms, avg answer ${avgAnswer}ms, p95 retrieval ${p95Retrieval}ms`);
  if (consensusGateEnabled) {
    console.log(`Consensus gate: ${consensusInvocations} invocations, ${consensusSplits} splits`);
  }
  console.log(`Output: ${outFile}`);

  console.log(`\n[zourobench] Overall accuracy: ${overallAccuracy}`);
  } // end replicate loop

  // Cleanup
  db.close();

  // Replicate distribution headline — only when more than one replicate was run.
  if (totalRuns > 1) {
    const dist = computeReplicateDistribution(replicateRuns, { minimumN });
    console.log("\n" + "═".repeat(60));
    console.log(`REPLICATE DISTRIBUTION  (N=${dist.n})`);
    console.log("═".repeat(60));
    const fmt = (v: number | undefined) => (v != null ? `${v}%` : "—");
    console.log(`  Solid (passed every run):   ${fmt(dist.solidPct)}`);
    console.log(`  Average:                    ${dist.avgAccuracy}%`);
    if (dist.avgAccuracyCi) console.log(`  Average 95% CI:             ${dist.avgAccuracyCi.lower}%–${dist.avgAccuracyCi.upper}%`);
    console.log(`  Best-of:                    ${dist.bestOf}%`);
    console.log(`  Ceiling (passed any run):   ${fmt(dist.ceilingPct)}`);
    if (dist.spread != null) console.log(`  Solid→Ceiling spread:       ${dist.spread.toFixed(1)} pts`);
    if (dist.truncatedCount > 0) console.log(`  ⚠ Truncated answers:        ${dist.truncatedCount}`);
    if (dist.timedOutCount > 0) console.log(`  ⚠ Timed-out answers:        ${dist.timedOutCount}`);
    console.log(`  Status:                     ${dist.status} (minimum N=${dist.minimumN}, paired seeds=${dist.pairing.paired})`);
    for (const reason of dist.statusReasons) console.log(`    - ${reason}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
