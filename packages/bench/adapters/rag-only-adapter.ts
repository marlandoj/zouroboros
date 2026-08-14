#!/usr/bin/env bun
/**
 * RAG-Only Benchmark — pure retrieval test, no structured fallback.
 *
 * For each question:
 *   1. Retrieve top-K facts via [fts | rag-core | none]
 *   2. Build context = retrieved fact texts only
 *   3. Ask the answer model to respond using ONLY that context
 *   4. Judge the answer against the expected answer
 *
 * Metrics:
 *   - retrieval recall@k (did the gold fact_id appear in top-K?)
 *   - retrieval MRR (mean reciprocal rank of the gold fact_id)
 *   - answer accuracy (judge correctness)
 *
 * Usage:
 *   bun adapters/rag-only-adapter.ts \
 *     --dataset data/rag-only/seed.json \
 *     --output data/runs/rag-only/ \
 *     --retriever rag-core    # one of: fts | rag-core | none
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";
import { randomUUID } from "crypto";

const EMBEDDING_MODEL = "text-embedding-3-small";
const ANSWER_MODEL = process.env.RAG_ONLY_ANSWER_MODEL ?? "gpt-4o-mini";
const JUDGE_MODEL = process.env.RAG_ONLY_JUDGE_MODEL ?? "gpt-4o";
const TOP_K = 5;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// ─── Seed types ────────────────────────────────────────────────────────
interface SeedFact {
  id: string;
  persona: string;
  entity: string;
  key: string;
  value: string;
  text: string;
}
interface SeedQuestion {
  id: string;
  fact_id: string;
  question: string;
  expected_answer: string;
}
interface Seed {
  metadata: { name: string; version: string; description: string };
  facts: SeedFact[];
  questions: SeedQuestion[];
}

// ─── Retriever types ───────────────────────────────────────────────────
interface RetrievalHit {
  fact_id: string;
  text: string;
  score: number;
}

// ─── OpenAI helpers ────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`embed ${res.status}: ${await res.text()}`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) ** 2));
        continue;
      }
      if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0].embedding;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) ** 2));
    }
  }
  throw lastErr ?? new Error("embed failed after retries");
}

async function chat(model: string, prompt: string, maxTokens = 256): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

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

// ─── DB setup ──────────────────────────────────────────────────────────
function initDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
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
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function seedFacts(db: Database, facts: SeedFact[]): void {
  const now = Date.now();
  const ins = db.prepare(
    "INSERT INTO facts (id, persona, entity, key, value, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const txn = db.transaction(() => {
    for (const f of facts) ins.run(f.id, f.persona, f.entity, f.key, f.value, f.text, now);
  });
  txn();
}

async function seedEmbeddings(db: Database, facts: SeedFact[]): Promise<void> {
  const ins = db.prepare("INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)");
  for (let i = 0; i < facts.length; i++) {
    const vec = await embed(facts[i].text);
    ins.run(facts[i].id, Buffer.from(new Float32Array(vec).buffer), EMBEDDING_MODEL);
    if ((i + 1) % 10 === 0 || i === facts.length - 1) {
      process.stdout.write(`\r  embedded ${i + 1}/${facts.length}`);
    }
  }
  console.log();
}

// ─── Retrievers ────────────────────────────────────────────────────────
function buildFts(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !["the", "what", "how", "why", "who", "when", "where", "does", "did", "for", "and", "are", "you", "can", "use", "this", "that"].includes(t));
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}*`).join(" OR ");
}

function retrieveFts(db: Database, query: string, topK: number): RetrievalHit[] {
  const fts = buildFts(query);
  if (!fts) return [];
  try {
    const rows = db.prepare(`
      SELECT f.id, f.text, f.value, rank
      FROM facts f JOIN facts_fts fts ON f.rowid = fts.rowid
      WHERE facts_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(fts, topK) as Array<{ id: string; text: string; value: string; rank: number }>;
    return rows.map((r) => ({ fact_id: r.id, text: `${r.value}\n${r.text}`, score: -r.rank }));
  } catch {
    return [];
  }
}

interface RagCoreSemanticHit {
  fact_id: string;
  entity: string | null;
  key: string | null;
  value: string | null;
  text: string | null;
  persona: string | null;
  score: number;
}
interface RagCoreModule {
  querySemantic: (
    query: string,
    options?: { topK?: number; filterEntity?: string; filterPersona?: string[]; minScore?: number },
  ) => Promise<RagCoreSemanticHit[]>;
}

const RAG_MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE ?? "0.0");
let _ragCore: RagCoreModule | null = null;
async function retrieveRagCore(query: string, topK: number): Promise<RetrievalHit[]> {
  if (!_ragCore) {
    const path = "/home/workspace/zouroboros/packages/rag/scripts/rag-core.ts";
    _ragCore = (await import(path)) as RagCoreModule;
  }
  const hits = await _ragCore.querySemantic(query, { topK, minScore: RAG_MIN_SCORE });
  return hits.map((h) => ({
    fact_id: h.fact_id,
    text: `${h.value ?? ""}\n${h.text ?? ""}`.trim(),
    score: h.score,
  }));
}

// ─── Answer + judge ────────────────────────────────────────────────────
const PROMPT_FILE = process.env.RAG_ONLY_PROMPT_FILE ?? "";
const DEFAULT_PROMPT = `You are answering a question using ONLY the context below. If the context does not contain enough information to answer, respond exactly with: I don't know.

Context:
{context}

Question: {question}

Answer (concise, factual, single paragraph):`;
let _promptTemplate: string | null = null;
function loadPromptTemplate(): string {
  if (_promptTemplate !== null) return _promptTemplate;
  if (PROMPT_FILE && existsSync(PROMPT_FILE)) {
    _promptTemplate = readFileSync(PROMPT_FILE, "utf-8");
  } else {
    _promptTemplate = DEFAULT_PROMPT;
  }
  return _promptTemplate;
}

async function answerFromContext(question: string, contextTexts: string[]): Promise<string> {
  const context = contextTexts.length > 0
    ? contextTexts.map((t, i) => `[${i + 1}] ${t}`).join("\n")
    : "(no context provided)";
  const tpl = loadPromptTemplate();
  const prompt = tpl.replace(/\{context\}/g, context).replace(/\{question\}/g, question);
  return chat(ANSWER_MODEL, prompt, 200);
}

async function judge(question: string, expected: string, predicted: string): Promise<{ correct: boolean; confidence: number; label: string }> {
  const prompt = `You are evaluating whether a predicted answer correctly answers a question, given the expected answer.

Question: ${question}
Expected answer: ${expected}
Predicted answer: ${predicted}

Is the predicted answer factually equivalent to the expected answer? Allow paraphrasing and partial-but-substantive matches. Respond with a single JSON object: {"correct": true|false, "confidence": 0.0-1.0, "label": "CORRECT" | "PARTIAL" | "INCORRECT" | "NO_ANSWER"}`;
  const raw = await chat(JUDGE_MODEL, prompt, 100);
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m?.[0] ?? raw);
    return { correct: !!obj.correct, confidence: Number(obj.confidence ?? 0), label: String(obj.label ?? "?") };
  } catch {
    return { correct: false, confidence: 0, label: "PARSE_FAIL" };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      output: { type: "string" },
      retriever: { type: "string" }, // fts | rag-core | none
      limit: { type: "string" },
    },
    strict: false,
  });

  if (!values.dataset || !values.output || !values.retriever) {
    console.error("Usage: bun adapters/rag-only-adapter.ts --dataset <path> --output <dir> --retriever <fts|rag-core|none> [--limit N]");
    process.exit(1);
  }
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY required");
    process.exit(1);
  }
  const retriever = values.retriever as "fts" | "rag-core" | "none";
  if (!["fts", "rag-core", "none"].includes(retriever)) {
    console.error(`invalid --retriever: ${retriever}`);
    process.exit(1);
  }

  const datasetPath = values.dataset as string;
  const outputDir = values.output as string;
  const seed: Seed = JSON.parse(readFileSync(datasetPath, "utf-8"));
  const limit = values.limit ? parseInt(values.limit as string, 10) : seed.questions.length;

  // DB setup — reuse pre-built bench DB if RAG_ONLY_BENCH_DB is set and exists,
  // otherwise build fresh under /tmp.
  const reuseDbPath = process.env.RAG_ONLY_BENCH_DB;
  let dbPath: string;
  let db: Database;
  if (reuseDbPath && existsSync(reuseDbPath)) {
    dbPath = reuseDbPath;
    process.env.ZOUROBOROS_MEMORY_DB = dbPath;
    db = new Database(dbPath);
    console.log(`[1/3] Reusing pre-built bench DB: ${dbPath}`);
    console.log(`[2/3] Skipping embeddings (reused)`);
  } else {
    const tmpDir = `/tmp/rag-only-${Date.now()}`;
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "bench.db");
    process.env.ZOUROBOROS_MEMORY_DB = dbPath;
    db = initDb(dbPath);

    console.log(`[1/3] Seeding ${seed.facts.length} facts...`);
    seedFacts(db, seed.facts);

    if (retriever === "rag-core") {
      console.log(`[2/3] Building embeddings...`);
      await seedEmbeddings(db, seed.facts);
    } else {
      console.log(`[2/3] Skipping embeddings (retriever=${retriever})`);
    }
  }

  console.log(`[3/3] Running ${limit} questions with retriever=${retriever}...\n`);
  const results: any[] = [];
  let answerCorrect = 0;
  let retrievalRecall = 0;
  let retrievalMrr = 0;
  let noAnswerCount = 0;
  const retrievalMs: number[] = [];
  const answerMs: number[] = [];

  for (const q of seed.questions.slice(0, limit)) {
    const tRetr = Date.now();
    let hits: RetrievalHit[] = [];
    if (retriever === "fts") hits = retrieveFts(db, q.question, TOP_K);
    else if (retriever === "rag-core") hits = await retrieveRagCore(q.question, TOP_K);
    // none: leave hits empty
    const retrieval_ms = Date.now() - tRetr;
    retrievalMs.push(retrieval_ms);

    // Retrieval metrics
    const goldRank = hits.findIndex((h) => h.fact_id === q.fact_id);
    const recallHit = goldRank >= 0 && goldRank < TOP_K ? 1 : 0;
    const rr = goldRank >= 0 ? 1 / (goldRank + 1) : 0;
    retrievalRecall += recallHit;
    retrievalMrr += rr;

    // Answer
    const tAns = Date.now();
    const predicted = await answerFromContext(q.question, hits.map((h) => h.text));
    const answer_ms = Date.now() - tAns;
    answerMs.push(answer_ms);
    const noAnswer = /^i don'?t know/i.test(predicted.trim());
    if (noAnswer) noAnswerCount++;

    // Judge
    const verdict = await judge(q.question, q.expected_answer, predicted);
    if (verdict.correct) answerCorrect++;

    const mark = verdict.correct ? "✓" : "✗";
    process.stdout.write(
      `  ${mark} ${q.id} (gold rank=${goldRank >= 0 ? goldRank + 1 : "miss"}, ${retrieval_ms}ms + ${answer_ms}ms, ${verdict.label})\n`,
    );
    results.push({
      id: q.id,
      fact_id: q.fact_id,
      question: q.question,
      expected: q.expected_answer,
      predicted,
      retrieved: hits.map((h) => ({ fact_id: h.fact_id, score: h.score })),
      gold_rank: goldRank >= 0 ? goldRank + 1 : null,
      recall_hit: recallHit,
      rr,
      retrieval_ms,
      answer_ms,
      judge: verdict,
      no_answer: noAnswer,
    });
  }

  const n = results.length;
  const recallPct = (retrievalRecall / n) * 100;
  const mrr = retrievalMrr / n;
  const accuracyPct = (answerCorrect / n) * 100;
  const noAnswerPct = (noAnswerCount / n) * 100;
  const avgRetr = Math.round(retrievalMs.reduce((a, b) => a + b, 0) / n);
  const avgAns = Math.round(answerMs.reduce((a, b) => a + b, 0) / n);

  console.log();
  console.log("═".repeat(60));
  console.log(`RAG-Only Benchmark — retriever=${retriever}`);
  console.log("═".repeat(60));
  console.log(`Retrieval Recall@${TOP_K}: ${recallPct.toFixed(1)}%`);
  console.log(`Retrieval MRR:        ${mrr.toFixed(3)}`);
  console.log(`Answer Accuracy:      ${accuracyPct.toFixed(1)}% (${answerCorrect}/${n})`);
  console.log(`No-answer rate:       ${noAnswerPct.toFixed(1)}%`);
  console.log(`Avg latency:          retrieval ${avgRetr}ms + answer ${avgAns}ms`);

  // Save
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, `RAG-only-${retriever}-${ts}.json`);
  writeFileSync(outPath, JSON.stringify({
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    dataset: datasetPath,
    retriever,
    top_k: TOP_K,
    scores: {
      retrieval_recall_at_k: recallPct,
      retrieval_mrr: mrr,
      answer_accuracy: accuracyPct,
      no_answer_rate: noAnswerPct,
    },
    latency: { avg_retrieval_ms: avgRetr, avg_answer_ms: avgAns },
    results,
  }, null, 2));
  console.log(`\nOutput: ${outPath}`);
  console.log(`METRIC=${accuracyPct.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
