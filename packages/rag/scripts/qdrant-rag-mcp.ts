#!/usr/bin/env bun
/**
 * qdrant-rag MCP Server
 *
 * Exposes the local self-hosted Qdrant RAG store as MCP tools so any MCP-aware
 * caller (Claude Code, Codex, Gemini, Hermes, swarm subagents) can query the
 * shared corpus without re-implementing the embed + search client.
 *
 * Tools:
 *   rag_search             — semantic search across one or all collections
 *   rag_list_collections   — enumerate collections + point counts
 *   rag_describe_collection — show config for a single collection
 *
 * Endpoint: stdio (MCP). Qdrant at 127.0.0.1:6333.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

// Dynamic import AFTER self-heal so model-client picks up the injected key.
const { embeddings: mcEmbeddings } = await import("./model-client");
const { rerank, rerankFast, rrf, hyde, cragVerdict, rewriteQuery, buildSparseVector } = await import("./rag-pipeline");
import type { Hit } from "./rag-pipeline";

// Cache schema lookups so we know whether a collection is named-vector (hybrid)
// or unnamed (legacy dense-only).
const SCHEMA_CACHE = new Map<string, { hasNamedDense: boolean; hasSparse: boolean }>();
async function collectionSchema(name: string): Promise<{ hasNamedDense: boolean; hasSparse: boolean }> {
  if (SCHEMA_CACHE.has(name)) return SCHEMA_CACHE.get(name)!;
  try {
    const info = await getCollectionInfo(name);
    const vec = info?.config?.params?.vectors;
    const sparse = info?.config?.params?.sparse_vectors;
    const hasNamedDense = vec && typeof vec === "object" && !("size" in vec);
    const hasSparse = !!sparse && Object.keys(sparse).length > 0;
    const result = { hasNamedDense, hasSparse };
    SCHEMA_CACHE.set(name, result);
    return result;
  } catch {
    return { hasNamedDense: false, hasSparse: false };
  }
}

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 30;
const PREVIEW_CHARS = 600;
const RERANK_CANDIDATE_MULTIPLIER = 4; // pull 4× topK candidates when reranking
const MAX_CANDIDATES = 40;

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}

async function qGet(path: string): Promise<any> {
  const r = await fetch(`${QDRANT_URL}${path}`, { headers: qHeaders() });
  if (!r.ok) throw new Error(`Qdrant GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function qPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method: "POST",
    headers: qHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function listCollections(): Promise<string[]> {
  const j = await qGet("/collections");
  return (j.result?.collections || []).map((c: any) => c.name);
}

async function getCollectionInfo(name: string): Promise<any> {
  const j = await qGet(`/collections/${name}`);
  return j.result;
}

async function searchCollection(
  collection: string,
  vector: number[],
  limit: number,
  options?: { hybridQuery?: string },
): Promise<any[]> {
  const schema = await collectionSchema(collection);
  // Hybrid path: Qdrant prefetch + RRF fusion across dense + sparse.
  if (options?.hybridQuery && schema.hasNamedDense && schema.hasSparse) {
    const sparse = buildSparseVector(options.hybridQuery);
    const body = {
      prefetch: [
        { query: vector, using: "dense", limit: Math.max(limit * 4, 20) },
        { query: { indices: sparse.indices, values: sparse.values }, using: "sparse", limit: Math.max(limit * 4, 20) },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
    };
    const j = await qPost(`/collections/${collection}/points/query`, body);
    return (j.result?.points || []).map((p: any) => ({ id: p.id, score: p.score, payload: p.payload }));
  }
  // Named-vector dense-only path (uses Query API with "using")
  if (schema.hasNamedDense) {
    const j = await qPost(`/collections/${collection}/points/query`, {
      query: vector,
      using: "dense",
      limit,
      with_payload: true,
    });
    return (j.result?.points || []).map((p: any) => ({ id: p.id, score: p.score, payload: p.payload }));
  }
  // Legacy unnamed dense path (default collection schema).
  const j = await qPost(`/collections/${collection}/points/search`, {
    vector,
    limit,
    with_payload: true,
  });
  return j.result || [];
}

function preview(s: string | undefined, n = PREVIEW_CHARS): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length > n ? cleaned.slice(0, n) + "…" : cleaned;
}

function formatHit(hit: any, collection: string): string {
  const p = hit.payload || {};
  const lines: string[] = [];
  lines.push(`[${collection}] score=${hit.score?.toFixed(3) ?? "?"}`);
  if (p.url) lines.push(`  url:    ${p.url}`);
  if (p.source) lines.push(`  source: ${p.source}`);
  if (p.package) lines.push(`  pkg:    ${p.package}`);
  if (p.entity || p.key) lines.push(`  entity: ${p.entity ?? ""}  key: ${p.key ?? ""}`);
  if (p.chunk_index !== undefined && p.chunk_total !== undefined) {
    lines.push(`  chunk:  ${p.chunk_index + 1}/${p.chunk_total}`);
  }
  const body = p.content || p.value || p.text || "";
  if (body) lines.push(`  ${preview(body)}`);
  return lines.join("\n");
}

async function embedFor(query: string, useHyde: boolean): Promise<{ vector: number[]; hypothetical?: string }> {
  if (useHyde) {
    const hypothetical = await hyde(query);
    const emb = await mcEmbeddings(hypothetical);
    return { vector: emb.embedding, hypothetical };
  }
  const emb = await mcEmbeddings(query);
  return { vector: emb.embedding };
}

async function gatherHits(
  targets: string[],
  vector: number[],
  perCollection: number,
  options?: { hybridQuery?: string },
): Promise<Hit[][]> {
  const lists = await Promise.all(
    targets.map(async (c): Promise<Hit[]> => {
      try {
        const raw = await searchCollection(c, vector, perCollection, options);
        return raw.map((h: any) => ({
          id: h.id,
          score: h.score ?? 0,
          payload: h.payload || {},
          collection: c,
        }));
      } catch {
        return [];
      }
    }),
  );
  return lists;
}

async function toolRagSearch(args: {
  query: string;
  collection?: string;
  limit?: number;
  reranker?: "flashrank" | "rankgpt" | "auto" | "none";
  hyde?: boolean;
  crag?: boolean;
  hybrid?: boolean;
}): Promise<string> {
  if (!args?.query) return "Error: query is required.";
  const limit = Math.max(1, Math.min(MAX_LIMIT, args.limit ?? DEFAULT_LIMIT));
  const useRerank = args.reranker !== "none";
  const reqRanker = args.reranker ?? (args.rerank === false ? "none" : "flashrank");
  const useHyde = args.hyde === true;
  const useCrag = args.crag === true;
  const useHybrid = args.hybrid !== false;

  // Backward compat: `rerank: false` → reranker = "none"
  const anythingRerank = args.reranker !== "none" && (args as any).rerank !== false;
  const candidatePool = anythingRerank
    ? Math.min(MAX_CANDIDATES, limit * RERANK_CANDIDATE_MULTIPLIER)
    : limit;

  const { vector, hypothetical } = await embedFor(args.query, useHyde);
  if (!vector?.length) return "Error: embedding generation failed.";

  const targets = args.collection ? [args.collection] : await listCollections();
  if (targets.length === 0) return "No collections in Qdrant.";

  const perCollection = targets.length === 1
    ? candidatePool
    : Math.max(3, Math.ceil(candidatePool / Math.min(targets.length, 3)));

  const searchOptions = useHybrid ? { hybridQuery: args.query } : undefined;
  let lists = await gatherHits(targets, vector, perCollection, searchOptions);
  let merged: Hit[] = targets.length === 1
    ? lists[0] ?? []
    : rrf(lists);

  let cragNote = "";
  if (useCrag && merged.length > 0) {
    const verdict = cragVerdict(merged);
    cragNote = `[crag] confidence=${verdict.confidence} topScore=${verdict.topScore.toFixed(3)} action=${verdict.action}`;
    if (verdict.action === "rewrite" || verdict.action === "fallback") {
      const rewritten = await rewriteQuery(args.query);
      if (rewritten && rewritten !== args.query) {
        const { vector: retryVec } = await embedFor(rewritten, false);
        if (retryVec?.length) {
          const retryOptions = useHybrid ? { hybridQuery: rewritten } : undefined;
          const retryLists = await gatherHits(targets, retryVec, perCollection, retryOptions);
          const retryMerged = targets.length === 1
            ? retryLists[0] ?? []
            : rrf(retryLists);
          merged = rrf([merged, retryMerged]);
          cragNote += ` rewritten='${rewritten.slice(0, 80)}'`;
        }
      }
    }
  }

  if (merged.length === 0) return "No matches.";

  if (anythingRerank) {
    if (reqRanker === "flashrank") {
      merged = await rerankFast(args.query, merged, limit);
    } else if (reqRanker === "rankgpt") {
      merged = await rerank(args.query, merged, limit);
    } else {
      // "auto": FlashRank pre-filter → RankGPT final order
      // FlashRank narrows the candidate pool fast, then RankGPT does the fine ordering
      const preFiltered = await rerankFast(args.query, merged, limit * 2);
      merged = await rerank(args.query, preFiltered, limit);
    }
  } else {
    merged = merged.slice(0, limit);
  }

  // Decide whether to surface hybrid in the header — only meaningful if any
  // target actually has a sparse vector configured.
  let hybridApplied = false;
  if (useHybrid) {
    for (const c of targets) {
      const schema = await collectionSchema(c);
      if (schema.hasSparse) { hybridApplied = true; break; }
    }
  }

  const header: string[] = [];
  if (hypothetical) header.push(`[hyde] hypothetical='${hypothetical.slice(0, 100)}…'`);
  if (hybridApplied) header.push(`[hybrid] dense+sparse RRF fusion at retrieval`);
  else if (useHybrid) header.push(`[hybrid] requested but no target collection has sparse vectors — dense-only`);
  if (cragNote) header.push(cragNote);
  if (anythingRerank) {
    const rlabel = reqRanker === "flashrank" ? "flashrank" : reqRanker === "rankgpt" ? "rankgpt" : "auto(fr+rgpt)";
    header.push(`[rerank:${rlabel}] candidate_pool=${candidatePool} → topK=${limit}`);
  }

  const body = merged.map((h) => formatHit(h, h.collection ?? "")).join("\n\n");
  return header.length ? `${header.join("\n")}\n\n${body}` : body;
}

async function toolListCollections(): Promise<string> {
  const names = await listCollections();
  if (names.length === 0) return "No collections.";
  const rows = await Promise.all(
    names.map(async (n) => {
      try {
        const info = await getCollectionInfo(n);
        const count = info?.points_count ?? "?";
        const dim = info?.config?.params?.vectors?.size ?? "?";
        return `  ${n}  points=${count}  dim=${dim}`;
      } catch {
        return `  ${n}  (error reading info)`;
      }
    }),
  );
  return `Qdrant @ ${QDRANT_URL}\n${rows.join("\n")}`;
}

async function toolDescribeCollection(args: { collection: string }): Promise<string> {
  if (!args?.collection) return "Error: collection is required.";
  const info = await getCollectionInfo(args.collection);
  return JSON.stringify(info, null, 2);
}

const server = new Server(
  { name: "qdrant-rag", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "rag_search",
      description:
        "Semantic search over the local Qdrant RAG store. Pass a query and (optionally) a collection name; omit collection to search across ALL collections and return the globally top-ranked passages. Multi-collection results are merged via Reciprocal Rank Fusion (RRF). By DEFAULT, results are RankGPT-reranked and hybrid dense+BM25 retrieval is used where the collection supports it — pass rerank:false / hybrid:false to opt out. HyDE query expansion and CRAG corrective retry remain opt-in. Use this whenever the user asks about Hermes Agent, Zouroboros internals, research papers in the corpus, FFB knowledge, Mimir facts, or anything that may live in a known collection.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Natural-language query." },
          collection: {
            type: "string",
            description:
              "Optional. Restrict to one collection (e.g. 'hermes-docs', 'zouroboros-code', 'zouroboros-research', 'shared-memory-facts', 'ffb-knowledge'). Omit to search all.",
          },
          limit: {
            type: "number",
            description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          },
          reranker: {
            type: "string",
            description: "Reranking strategy: 'flashrank' (local cross-encoder, sub-50ms, zero-API, default), 'auto' (FlashRank pre-filter + RankGPT), 'rankgpt' (LLM listwise), 'none' (skip reranking). Replaces deprecated rerank: boolean.",
          },
          hyde: {
            type: "boolean",
            description: "Generate a hypothetical answer first and embed THAT instead of the raw query (HyDE). Helps for short/ambiguous queries.",
          },
          crag: {
            type: "boolean",
            description: "Corrective retrieval: score top result; if below threshold, rewrite query and retry-fuse. Use when the corpus may not contain the answer.",
          },
          hybrid: {
            type: "boolean",
            description: "Default: ENABLED. Hybrid dense + BM25 sparse retrieval with Qdrant RRF fusion. Only effective on collections built with sparse vectors (currently: hermes-docs); auto-falls back to dense-only on legacy collections. Set false to force dense-only everywhere.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "rag_list_collections",
      description: "List all Qdrant collections with point counts and vector dimensions.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "rag_describe_collection",
      description: "Show full config + stats for a single Qdrant collection.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string", description: "Collection name." },
        },
        required: ["collection"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let text: string;
    switch (name) {
      case "rag_search":
        text = await toolRagSearch(args as any);
        break;
      case "rag_list_collections":
        text = await toolListCollections();
        break;
      case "rag_describe_collection":
        text = await toolDescribeCollection(args as any);
        break;
      default:
        text = `Unknown tool: ${name}`;
    }
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("qdrant-rag MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
