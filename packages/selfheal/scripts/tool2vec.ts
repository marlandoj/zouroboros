#!/usr/bin/env bun
/**
 * Tool2Vec — M10 t8
 *
 * Re-embeds tool descriptions using actual usage-pattern narratives (not raw
 * docstrings). Stores results in Qdrant `tool-semantics` collection and
 * measures Recall@K delta vs naive docstring baseline.
 *
 * Usage:
 *   bun tool2vec.ts embed      # build embeddings + upsert to Qdrant
 *   bun tool2vec.ts eval       # run Recall@K benchmark
 *   bun tool2vec.ts run        # embed + eval (default)
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const WORKSPACE = process.env.WORKSPACE_ROOT ?? "/home/workspace";
const REGISTRY_PATH = join(WORKSPACE, "zouroboros/packages/swarm/src/executor/registry/executor-registry.json");
const DB_PATH = process.env.ZOUROBOROS_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const QDRANT_URL = "http://localhost:6333";
const COLLECTION = "tool-semantics";
const VECTOR_SIZE = 1536;
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY || "";
const EMBED_MODEL = "text-embedding-3-small";

// ── Types ──────────────────────────────────────────────────────────────────

interface ToolProfile {
  toolName: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  failureTypes: string[];
  personas: string[];
  sessions: number;
}

interface ToolDoc {
  toolName: string;
  baseline: string;        // original docstring from registry
  usageNarrative: string; // Tool2Vec: LLM-enriched description
}

// ── Step 1: Build usage profiles from tool_calls ──────────────────────────

async function llmSummary(toolName: string, description: string, examples: string[]): Promise<string> {
  if (!OPENAI_KEY) return description;
  
  const prompt = `You are a tool-profiling assistant. Your goal is to rewrite a tool's description based on how it is ACTUALLY used in production, without losing its original precision.

Original Description: ${description}

Examples of successful usage (args):
${examples.map(e => `- ${e}`).join("\n")}

Task: Write a concise (2-3 sentences) "Usage-Enriched Description" for the tool "${toolName}". 
Focus on semantic meaning and intent. Do NOT mention specific success rates or execution times. 
Describe WHAT the tool does and WHEN it should be used based on the examples.
CRITICAL: You MUST retain the exact technical keywords and core purpose from the Original Description. The goal is to ENRICH the baseline with context, not replace its technical accuracy.

Enriched Description:`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    console.error(`LLM error for ${toolName}: ${await resp.text()}`);
    return description;
  }
  const data = await resp.json() as any;
  return data.choices[0].message.content.trim();
}

// ── Step 2: Convert profiles to enriched narratives ───────────────────────

function profileToNarrative(p: ToolProfile): string {
  const successPct = Math.round(p.successRate * 100);
  const speed = p.avgDurationMs < 200 ? "very fast" :
                p.avgDurationMs < 800 ? "fast" :
                p.avgDurationMs < 3000 ? "moderate" :
                p.avgDurationMs < 15000 ? "slow" : "very slow";

  const reliability = successPct >= 98 ? "highly reliable" :
                      successPct >= 90 ? "reliable" :
                      successPct >= 75 ? "moderately reliable" : "error-prone";

  // Infer semantic category from tool name
  let category = "general";
  const n = p.toolName.toLowerCase();
  if (n.includes("bash") || n.includes("run_bash") || n.includes("run_sequential") || n.includes("run_parallel")) {
    category = "shell execution and system operations";
  } else if (n.includes("read") || n.includes("write") || n.includes("edit") || n.includes("glob") || n.includes("grep")) {
    category = "file system operations (read, write, search)";
  } else if (n.includes("memory") || n.includes("mimir") || n.includes("cognitive")) {
    category = "memory storage and retrieval";
  } else if (n.includes("space_route") || n.includes("space_asset") || n.includes("space_errors")) {
    category = "zo.space web route management and deployment";
  } else if (n.includes("agent") || n.includes("swarm") || n.includes("bench")) {
    category = "agent orchestration and evaluation";
  } else if (n.includes("email") || n.includes("sms") || n.includes("send")) {
    category = "communication and notifications";
  } else if (n.includes("tradingview") || n.includes("alpaca") || n.includes("broker")) {
    category = "financial data and trading operations";
  } else if (n.includes("web_search") || n.includes("webpage") || n.includes("firecrawl")) {
    category = "web search and content retrieval";
  } else if (n.includes("todo") || n.includes("task")) {
    category = "task tracking and planning";
  } else if (n.includes("tool_search") || n.includes("toolsearch")) {
    category = "tool discovery and schema loading";
  }

  const failPart = p.failureTypes.length > 0
    ? ` When it fails, the error is typically: ${p.failureTypes.filter(f => f !== "null").join(", ") || "execution_error"}.`
    : " Failures are rare.";

  const personaPart = p.personas.length > 0
    ? ` Most commonly used by persona: ${p.personas.slice(0, 2).join(", ")}.`
    : "";

  return [
    `Tool: ${p.toolName}`,
    `Category: ${category}`,
    `Usage statistics: called ${p.totalCalls} times across ${p.sessions} sessions.`,
    `Reliability: ${reliability} (${successPct}% success rate).`,
    `Performance: ${speed} execution — average ${p.avgDurationMs}ms, p95 ${p.p95DurationMs}ms.`,
    failPart,
    personaPart,
    `Use this tool when you need to perform ${category}.`,
  ].join(" ");
}

async function buildDocs(): Promise<ToolDoc[]> {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  const executors = registry.executors || [];
  const executorMap = new Map(executors.map((ex: any) => [ex.id, ex]));

  const db = new Database(DB_PATH, { readonly: true });
  const docs: ToolDoc[] = [];

  try {
    const tools = db.query("SELECT DISTINCT tool_name FROM tool_calls WHERE tool_name NOT LIKE 'bench:%'").all() as { tool_name: string }[];
    
    console.log(`\n▶ Generating enriched narratives for ${tools.length} tools...`);

    for (const { tool_name } of tools) {
      const ex = executorMap.get(tool_name);
      const baseline = ex?.description || `Tool for ${tool_name}`;
      
      const examples = db.query(`
        SELECT tool_args FROM tool_calls
        WHERE tool_name = ? AND outcome = 'success' AND tool_args != ''
        ORDER BY created_at DESC LIMIT 10
      `).all(tool_name) as { tool_args: string }[];

      const argList = examples.map(e => e.tool_args);
      const llmDesc = await llmSummary(tool_name, baseline, argList);
      const usageNarrative = baseline + " " + llmDesc;
      
      docs.push({ toolName: tool_name, baseline, usageNarrative });
      process.stdout.write(".");
    }
    console.log("\n");
  } finally {
    db.close();
  }
  return docs;
}

// ── Step 3: OpenAI embeddings ─────────────────────────────────────────────

async function embed(texts: string[]): Promise<number[][]> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: EMBED_MODEL }),
  });
  if (!resp.ok) throw new Error(`OpenAI embed error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { data: { embedding: number[]; index: number }[] };
  const result = new Array(texts.length);
  for (const d of data.data) result[d.index] = d.embedding;
  return result;
}

// ── Step 4: Qdrant helpers ────────────────────────────────────────────────

async function qdrantRequest(method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function ensureCollection(): Promise<void> {
  const existing = await qdrantRequest("GET", `/collections/${COLLECTION}`);
  if (existing?.status === "ok") {
    console.log(`  Collection "${COLLECTION}" already exists — recreating for fresh embeddings`);
    await qdrantRequest("DELETE", `/collections/${COLLECTION}`);
  }
  await qdrantRequest("PUT", `/collections/${COLLECTION}`, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });
  console.log(`  Created collection "${COLLECTION}" (${VECTOR_SIZE}d Cosine)`);
}

async function upsertPoints(points: { id: string; vector: number[]; payload: Record<string, unknown> }[]): Promise<void> {
  await qdrantRequest("PUT", `/collections/${COLLECTION}/points`, { points });
}

// ── Step 5: Embed phase ───────────────────────────────────────────────────

async function embedPhase(docs: ToolDoc[]): Promise<void> {
  console.log(`\n▶ Embedding ${docs.length} tools (both baseline + Tool2Vec)...`);
  await ensureCollection();

  const BATCH = 20;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const narratives = batch.map(d => d.usageNarrative);
    const baselines  = batch.map(d => d.baseline);

    const [nvecs, bvecs] = await Promise.all([embed(narratives), embed(baselines)]);

    const points = batch.flatMap((d, j) => [
      {
        id: randomUUID(),
        vector: nvecs[j],
        payload: {
          tool_name: d.toolName,
          embedding_type: "tool2vec",
          text: d.usageNarrative,
        },
      },
      {
        id: randomUUID(),
        vector: bvecs[j],
        payload: {
          tool_name: d.toolName,
          embedding_type: "baseline",
          text: d.baseline,
        },
      },
    ]);

    await upsertPoints(points);
    console.log(`  Upserted ${i + batch.length}/${docs.length}`);
  }

  console.log(`  ✅ ${docs.length * 2} vectors stored (${docs.length} Tool2Vec + ${docs.length} baseline)`);
}

// ── Step 6: Recall@K evaluation ──────────────────────────────────────────

const EVAL_QUERIES: { query: string; expectedTool: string }[] = [
  { query: "execute a shell command or run a bash script", expectedTool: "Bash" },
  { query: "run a system command on the remote server", expectedTool: "mcp__zo__run_bash_command" },
  { query: "read or view a file's contents", expectedTool: "Read" },
  { query: "create or overwrite a file with new content", expectedTool: "Write" },
  { query: "make targeted changes to an existing file", expectedTool: "Edit" },
  { query: "search for a pattern inside files", expectedTool: "Grep" },
  { query: "find files matching a glob pattern", expectedTool: "Glob" },
  { query: "store or save information to memory", expectedTool: "mcp__zo-memory-stdio__memory_store" },
  { query: "retrieve or search stored memories", expectedTool: "mcp__zo-memory-stdio__memory_search" },
  { query: "send an email notification to the user", expectedTool: "mcp__zo__send_email_to_user" },
  { query: "update or create a web page route on zo.space", expectedTool: "mcp__zo__write_space_route" },
  { query: "screen stocks or ETFs on TradingView", expectedTool: "mcp__tradingview__screen_stocks" },
  { query: "load a tool schema before calling it", expectedTool: "ToolSearch" },
  { query: "track tasks or mark progress on a todo list", expectedTool: "TodoWrite" },
  { query: "run a parallel or complex multi-step agent task", expectedTool: "Agent" },
];

async function recallAtK(queryVec: number[], targetTool: string, embType: "tool2vec" | "baseline", k: number): Promise<boolean> {
  const resp = await qdrantRequest("POST", `/collections/${COLLECTION}/points/search`, {
    vector: queryVec,
    limit: k * 2, // fetch more to filter by embedding_type
    with_payload: true,
    filter: {
      must: [{ key: "embedding_type", match: { value: embType } }],
    },
  });

  const hits = (resp?.result ?? []).slice(0, k);
  return hits.some((h: any) => h.payload?.tool_name === targetTool);
}

async function evalPhase(): Promise<void> {
  console.log(`\n▶ Running Recall@K evaluation (${EVAL_QUERIES.length} queries, K=1,3,5)...`);

  const Ks = [1, 3, 5];
  const results: Record<string, { tool2vec: number; baseline: number }> = {};
  for (const k of Ks) results[`K${k}`] = { tool2vec: 0, baseline: 0 };

  const failures: { query: string; expected: string; got_t2v: string[]; got_base: string[] }[] = [];

  for (const { query, expectedTool } of EVAL_QUERIES) {
    const [qvec] = await embed([query]);

    const [t2v_hits, base_hits] = await Promise.all([
      getHits(qvec, "tool2vec", 5),
      getHits(qvec, "baseline", 5),
    ]);

    for (const k of Ks) {
      if (t2v_hits.slice(0, k).includes(expectedTool)) results[`K${k}`].tool2vec++;
      if (base_hits.slice(0, k).includes(expectedTool)) results[`K${k}`].baseline++;
    }

    if (!t2v_hits.slice(0, 1).includes(expectedTool) || !base_hits.slice(0, 1).includes(expectedTool)) {
      failures.push({ query, expected: expectedTool, got_t2v: t2v_hits.slice(0, 3), got_base: base_hits.slice(0, 3) });
    }

    process.stdout.write(".");
  }
  console.log("\n");

  if (failures.length > 0) {
    console.log("Failures at K=1:");
    for (const f of failures) {
      const t2v_ok = f.got_t2v[0] === f.expected;
      const base_ok = f.got_base[0] === f.expected;
      if (t2v_ok && base_ok) continue;
      
      console.log(`  Query: "${f.query}"`);
      console.log(`    Expected: ${f.expected}`);
      console.log(`    Tool2Vec [${t2v_ok ? "✅" : "❌"}]: ${f.got_t2v.join(", ")}`);
      console.log(`    Baseline [${base_ok ? "✅" : "❌"}]: ${f.got_base.join(", ")}`);
    }
  }

  const n = EVAL_QUERIES.length;
  console.log("┌──────────┬──────────────┬──────────────┬─────────┐");
  console.log("│ Metric   │ Tool2Vec     │ Baseline     │ Delta   │");
  console.log("├──────────┼──────────────┼──────────────┼─────────┤");
  for (const k of Ks) {
    const t = results[`K${k}`].tool2vec;
    const b = results[`K${k}`].baseline;
    const delta = t - b;
    const sign = delta >= 0 ? "+" : "";
    console.log(
      `│ Recall@${k} │ ${String(t).padStart(3)}/${n} (${String(Math.round(t/n*100)).padStart(3)}%) │ ${String(b).padStart(3)}/${n} (${String(Math.round(b/n*100)).padStart(3)}%) │ ${sign}${delta}/${n}  │`
    );
  }
  console.log("└──────────┴──────────────┴──────────────┴─────────┘");

  const k1Delta = results["K1"].tool2vec - results["K1"].baseline;
  const verdict = k1Delta > 0 ? "✅ Tool2Vec outperforms baseline at K=1"
    : k1Delta === 0 ? "⚠️  Tied at K=1 — usage narratives not hurting, not helping"
    : "❌ Baseline outperforms Tool2Vec at K=1 — investigate narrative quality";
  console.log(`\n${verdict}`);

  // Save results to DB
  const db = new Database(DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(`CREATE TABLE IF NOT EXISTS tool2vec_evals (
    id TEXT PRIMARY KEY,
    run_at INTEGER DEFAULT (strftime('%s','now')),
    n_tools INTEGER,
    n_queries INTEGER,
    recall_at_1_t2v REAL,
    recall_at_3_t2v REAL,
    recall_at_5_t2v REAL,
    recall_at_1_base REAL,
    recall_at_3_base REAL,
    recall_at_5_base REAL,
    delta_at_1 REAL
  )`);
  db.run(
    `INSERT INTO tool2vec_evals VALUES (?,strftime('%s','now'),?,?,?,?,?,?,?,?,?)`,
    [
      randomUUID(),
      EVAL_QUERIES.filter(q => q.expectedTool !== "").length, // approximate n_tools
      n,
      results["K1"].tool2vec / n,
      results["K3"].tool2vec / n,
      results["K5"].tool2vec / n,
      results["K1"].baseline / n,
      results["K3"].baseline / n,
      results["K5"].baseline / n,
      k1Delta / n,
    ]
  );
  db.close();
  console.log("  Eval results saved to tool2vec_evals table.");
}

async function getHits(queryVec: number[], embType: "tool2vec" | "baseline", k: number): Promise<string[]> {
  const resp = await qdrantRequest("POST", `/collections/${COLLECTION}/points/search`, {
    vector: queryVec,
    limit: k * 5, // fetch more to filter
    with_payload: true,
    filter: {
      must: [{ key: "embedding_type", match: { value: embType } }],
    },
  });
  return (resp?.result ?? []).map((h: any) => h.payload?.tool_name as string).slice(0, k);
}

// ── Main ──────────────────────────────────────────────────────────────────

const cmd = process.argv[2] ?? "run";

console.log(`\nTool2Vec — M10 t8`);
console.log(`DB: ${DB_PATH}`);
console.log(`Registry: ${REGISTRY_PATH}`);

const docs = await buildDocs();

if (cmd === "embed" || cmd === "run") {
  await embedPhase(docs);
}
if (cmd === "eval" || cmd === "run") {
  await evalPhase();
}
