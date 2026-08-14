/**
 * RAG Enrichment Module for Swarm Orchestrator
 *
 * Enriches task prompts with relevant context from the shared Qdrant corpus,
 * routed through the same retrieval pipeline as the qdrant-rag MCP server:
 *   multi-collection dense + hybrid (BM25+dense RRF) fan-out
 *     → Reciprocal Rank Fusion across collections
 *     → RankGPT rerank to topK.
 *
 * Embeddings: OpenAI text-embedding-3-small (1536d) via model-client. No local
 * models — Zo has no GPU. Rerank generation uses gpt-4o-mini. There is no
 * No Ollama/nomic paths — all embeddings routed through OpenAI text-embedding-3-small.
 *
 * Integration: called from buildOptimizedPrompt() in orchestrate-v5.ts.
 */

import { embeddings as mcEmbeddings } from "/home/workspace/Skills/zo-memory-system/scripts/model-client.ts";
import { rerank, rrf, buildSparseVector, type Hit } from "/home/workspace/Skills/zo-memory-system/scripts/rag-pipeline.ts";

interface RAGEnrichmentOptions {
  topK?: number;
  collections?: string[];
  hybrid?: boolean; // dense+BM25 fusion on hybrid-capable collections (default: on)
  rerank?: boolean; // RankGPT listwise rerank (default: on)
}

// Shared knowledge collections the swarm draws on. Mix of legacy unnamed-dense
// (research/code/facts/docs) and named-vector+sparse (hermes-docs is hybrid).
const DEFAULT_COLLECTIONS = [
  "zouroboros-research",
  "zouroboros-code",
  "shared-memory-facts",
  "code-docs",
  "hermes-docs",
];

// Keywords that trigger RAG lookup — skip enrichment for tasks with no plausible
// knowledge-base overlap to avoid a wasted embed + rerank round-trip.
const RAG_TRIGGER_KEYWORDS = [
  "agent", "llm", "model", "embedding", "vector", "rag", "memory",
  "api", "route", "middleware", "validation", "schema",
  "database", "orm", "query", "migration",
  "payment", "stripe", "subscription",
  "workflow", "orchestration", "handoff", "tool",
  "streaming", "async", "concurrent",
];

const RERANK_CANDIDATE_MULTIPLIER = 4; // pull 4× topK candidates when reranking
const MAX_CANDIDATES = 40;

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}

/**
 * Check if a task would benefit from RAG enrichment.
 */
export function shouldEnrichWithRAG(taskText: string): boolean {
  const lowerText = taskText.toLowerCase();
  return RAG_TRIGGER_KEYWORDS.some((kw) => lowerText.includes(kw));
}

// Cache schema lookups so we know whether a collection is named-vector (hybrid)
// or unnamed (legacy dense-only). Mirrors the qdrant-rag MCP server.
const SCHEMA_CACHE = new Map<string, { hasNamedDense: boolean; hasSparse: boolean }>();
async function collectionSchema(name: string): Promise<{ hasNamedDense: boolean; hasSparse: boolean }> {
  if (SCHEMA_CACHE.has(name)) return SCHEMA_CACHE.get(name)!;
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${name}`, { headers: qHeaders() });
    if (!r.ok) throw new Error(`schema ${r.status}`);
    const info = (await r.json() as any).result;
    const vec = info?.config?.params?.vectors;
    const sparse = info?.config?.params?.sparse_vectors;
    const hasNamedDense = !!vec && typeof vec === "object" && !("size" in vec);
    const hasSparse = !!sparse && Object.keys(sparse).length > 0;
    const result = { hasNamedDense, hasSparse };
    SCHEMA_CACHE.set(name, result);
    return result;
  } catch {
    return { hasNamedDense: false, hasSparse: false };
  }
}

/**
 * Search one collection. Three paths, matching the MCP server:
 *   1. hybrid (named dense + sparse): Qdrant prefetch + RRF fusion
 *   2. named-vector dense-only: Query API with `using: "dense"`
 *   3. legacy unnamed dense: classic /points/search
 */
async function searchCollection(
  collection: string,
  vector: number[],
  limit: number,
  hybridQuery?: string,
): Promise<Array<{ id: string | number; score: number; payload: Record<string, any> }>> {
  const schema = await collectionSchema(collection);
  if (hybridQuery && schema.hasNamedDense && schema.hasSparse) {
    const sparse = buildSparseVector(hybridQuery);
    const body = {
      prefetch: [
        { query: vector, using: "dense", limit: Math.max(limit * 4, 20) },
        { query: { indices: sparse.indices, values: sparse.values }, using: "sparse", limit: Math.max(limit * 4, 20) },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
    };
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/query`, { method: "POST", headers: qHeaders(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`query ${r.status}`);
    return ((await r.json() as any).result?.points || []).map((p: any) => ({ id: p.id, score: p.score, payload: p.payload }));
  }
  if (schema.hasNamedDense) {
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/query`, { method: "POST", headers: qHeaders(), body: JSON.stringify({ query: vector, using: "dense", limit, with_payload: true }) });
    if (!r.ok) throw new Error(`query ${r.status}`);
    return ((await r.json() as any).result?.points || []).map((p: any) => ({ id: p.id, score: p.score, payload: p.payload }));
  }
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, { method: "POST", headers: qHeaders(), body: JSON.stringify({ vector, limit, with_payload: true }) });
  if (!r.ok) throw new Error(`search ${r.status}`);
  return (await r.json() as any).result || [];
}

/**
 * Format reranked hits for prompt injection.
 */
function formatRAGContext(hits: Hit[]): string {
  if (hits.length === 0) return "";

  const sections = hits.map((h, i) => {
    const p = h.payload || {};
    const src = p.source || p.url || p.package || p.entity || h.collection || "context";
    const body = String(p.content || p.value || p.text || p.summary || "").replace(/\s+/g, " ").trim();
    return `### Pattern ${i + 1}: [${h.collection}] ${String(src).replace(/\.md$/, "")}
${body.slice(0, 800)}${body.length > 800 ? "…" : ""}`;
  });

  return `## Relevant Context from Zouroboros Knowledge Base

The following patterns may be helpful for this task. Use them as reference for implementation:

${sections.join("\n\n")}

---
`;
}

/**
 * Main enrichment function — call this from buildOptimizedPrompt().
 */
export async function enrichTaskWithRAG(
  taskText: string,
  options: RAGEnrichmentOptions = {},
): Promise<{ context: string; latencyMs: number; patterns: number }> {
  const startTime = Date.now();

  if (!shouldEnrichWithRAG(taskText)) {
    return { context: "", latencyMs: 0, patterns: 0 };
  }

  try {
    const topK = options.topK ?? 3;
    const useRerank = options.rerank !== false;
    const useHybrid = options.hybrid !== false;
    const collections = options.collections ?? DEFAULT_COLLECTIONS;

    const emb = await mcEmbeddings(taskText);
    const vector = emb.embedding;
    if (!vector?.length) throw new Error("embedding generation failed");

    const candidatePool = useRerank ? Math.min(MAX_CANDIDATES, topK * RERANK_CANDIDATE_MULTIPLIER) : topK;
    const perCollection = Math.max(3, Math.ceil(candidatePool / Math.min(collections.length, 3)));

    const lists = await Promise.all(
      collections.map(async (c): Promise<Hit[]> => {
        try {
          const raw = await searchCollection(c, vector, perCollection, useHybrid ? taskText : undefined);
          return raw.map((h) => ({ id: h.id, score: h.score ?? 0, payload: h.payload || {}, collection: c }));
        } catch {
          return [];
        }
      }),
    );

    const merged = rrf(lists);
    if (merged.length === 0) {
      return { context: "", latencyMs: Date.now() - startTime, patterns: 0 };
    }

    const top = useRerank ? await rerank(taskText, merged, topK) : merged.slice(0, topK);
    const context = formatRAGContext(top);

    return { context, latencyMs: Date.now() - startTime, patterns: top.length };
  } catch (error) {
    // Fail silently — RAG enrichment is additive, not required.
    console.log(`  [RAG] Enrichment failed (non-blocking): ${error}`);
    return { context: "", latencyMs: Date.now() - startTime, patterns: 0 };
  }
}

/**
 * Batch enrichment for multiple tasks (used in preflight).
 */
export async function prefetchRAGForTasks(
  tasks: Array<{ id: string; task: string }>,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const concurrency = 3;
  const queue = [...tasks];

  async function processBatch() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (shouldEnrichWithRAG(item.task)) {
        const { context } = await enrichTaskWithRAG(item.task);
        if (context) results.set(item.id, context);
      }
    }
  }

  await Promise.all(Array(concurrency).fill(null).map(processBatch));
  return results;
}

// CLI test mode
if (import.meta.main) {
  const testTask = process.argv[2] || "Build a multi-agent workflow with handoffs using the OpenAI Agents SDK";

  console.log("Testing RAG enrichment (dense+hybrid → RRF → rerank)...\n");
  console.log(`Task: ${testTask}\n`);

  const { context, latencyMs, patterns } = await enrichTaskWithRAG(testTask, { topK: 3 });

  if (patterns > 0) {
    console.log(`✅ Found ${patterns} relevant patterns in ${latencyMs}ms\n`);
    console.log(context);
  } else {
    console.log(`⚠️ No relevant patterns found (${latencyMs}ms)`);
  }
}
