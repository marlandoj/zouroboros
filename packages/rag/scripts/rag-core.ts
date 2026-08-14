/**
 * rag-core.ts — Unified RAG embedding + retrieval core
 *
 * Centralizes:
 * - Embedding via memory-system model-client (OpenAI text-embedding-3-small)
 * - DB path resolution (shared-facts.db)
 * - Cosine similarity + vector math
 * - Config lookup from rag-config.db
 *
 * Replaces inline Ollama calls in all RAG scripts.
 */

import { Database } from "bun:sqlite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Lazy-load model-client to avoid tsc import path issues ─────────────────
type EmbedFn = (text: string, explicitModel?: string) => Promise<{ embedding?: number[]; error?: string }>;

let _embeddingsPromise: Promise<EmbedFn> | null = null;
async function getEmbeddingsFn(): Promise<EmbedFn> {
  if (_embeddingsPromise) return _embeddingsPromise;
  _embeddingsPromise = (async () => {
    let fn: EmbedFn | undefined;
    try {
      const mc = await import("/home/workspace/Skills/zo-memory-system/scripts/model-client.ts");
      fn = mc.embeddings as EmbedFn;
    } catch {
      const mc = await import("/home/workspace/Skills/zo-memory-system/scripts/model-client.js");
      fn = mc.embeddings as EmbedFn;
    }
    if (!fn) throw new Error("Cannot load model-client.embeddings");
    return fn;
  })().catch((err) => {
    _embeddingsPromise = null;
    throw err;
  });
  return _embeddingsPromise;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Paths ──────────────────────────────────────────────────────────────────
export const MEMORY_DB =
  process.env.ZOUROBOROS_MEMORY_DB ||
  process.env.ZO_MEMORY_DB ||
  "/home/workspace/.zo/memory/shared-facts.db";

export const CONFIG_DB = resolve(__dirname, "../data/rag-config.db");

export const EMBEDDING_MODEL = "text-embedding-3-small"; // Fixed — must match memory system

// ─── Embedding (via memory system model-client) ─────────────────────────────
export async function embed(text: string): Promise<number[]> {
  const fn = await getEmbeddingsFn();
  const result = await fn(text, EMBEDDING_MODEL);
  if (!result.embedding?.length) {
    throw new Error(`Embedding generation failed: ${result.error || "empty"}`);
  }
  return result.embedding;
}

// ─── Cosine similarity ─────────────────────────────────────────────────────
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// ─── Decode BLOB embedding from DB ───────────────────────────────────────────
export function decodeEmbedding(blob: unknown): number[] {
  let bytes: Uint8Array;
  if (blob instanceof Uint8Array) {
    bytes = blob;
  } else if (blob && typeof blob === "object" && "buffer" in (blob as any) && "byteLength" in (blob as any)) {
    const view = blob as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else {
    throw new Error(`Cannot decode embedding of type ${typeof blob}`);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`Embedding blob length ${bytes.byteLength} is not 4-byte aligned`);
  }
  // Copy into a fresh aligned buffer — source byteOffset is not guaranteed 4-aligned
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return Array.from(new Float32Array(aligned.buffer));
}

// ─── DB helpers ─────────────────────────────────────────────────────────────
export function getMemoryDb(readonly = false): Database {
  return new Database(MEMORY_DB, { readonly });
}

export function getConfigDb(readonly = false): Database {
  return new Database(CONFIG_DB, { readonly });
}

// ─── Config lookup ──────────────────────────────────────────────────────────
export interface RagConfig {
  top_k: number;
  fusion_weight: number;
}

export function getConfig(area: string): RagConfig {
  let db: Database | null = null;
  try {
    db = getConfigDb(true);
    const row = db
      .query(
        "SELECT top_k, fusion_weight FROM rag_configs WHERE area = ? AND enabled = 1 LIMIT 1"
      )
      .get(area) as any;
    return { top_k: row?.top_k ?? 5, fusion_weight: row?.fusion_weight ?? 0.5 };
  } catch {
    return { top_k: 5, fusion_weight: 0.5 };
  } finally {
    db?.close();
  }
}

// ─── Semantic search over fact_embeddings ───────────────────────────────────-
export interface SemanticHit {
  fact_id: string;
  entity: string | null;
  key: string | null;
  value: string | null;
  score: number;
}

export async function querySemantic(query: string, options?: { topK?: number; filterEntity?: string }): Promise<SemanticHit[]> {
  const qVec = await embed(query);
  const db = getMemoryDb(true);

  try {
    const params: any[] = [EMBEDDING_MODEL];
    let whereParts = ["e.model = ?"];
    if (options?.filterEntity) {
      whereParts.push("f.entity LIKE ?");
      params.push(`${options.filterEntity}%`);
    }

    const sql = `
      SELECT e.fact_id, e.embedding, f.entity, f.key, f.value
      FROM fact_embeddings e
      LEFT JOIN facts f ON f.id = e.fact_id
      WHERE ${whereParts.join(" AND ")}
    `;

    const rows = db.query(sql.trim()).all(...params) as any[];

    const scored: SemanticHit[] = rows
      .map((row) => {
        const dbVec = decodeEmbedding(row.embedding);
        return {
          fact_id: row.fact_id,
          entity: row.entity ?? null,
          key: row.key ?? null,
          value: row.value ?? null,
          score: cosineSim(qVec, dbVec),
        };
      })
      .filter((h) => !isNaN(h.score));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options?.topK ?? 5);
  } finally {
    db.close();
  }
}

// ─── Episode / Procedure queries ────────────────────────────────────────────
export interface EpisodeHit {
  id: string;
  summary: string;
  outcome: string;
  duration_ms: number;
  happened_at: string;
  procedure_id: string | null;
}

export function queryEpisodes(entityPrefix: string, limit = 5): EpisodeHit[] {
  const db = getMemoryDb(true);
  try {
    const ep = db
      .query(
        `SELECT e.id, e.summary, e.outcome, e.duration_ms, e.happened_at, e.procedure_id
         FROM episodes e
         JOIN episode_entities ee ON ee.episode_id = e.id
         JOIN entities ent ON ent.entity = ee.entity
         WHERE ent.entity LIKE ?
         ORDER BY e.happened_at DESC
         LIMIT ?`
      )
      .all(`${entityPrefix}%`, limit) as any[];
    return ep;
  } finally {
    db.close();
  }
}

// ─── Graceful "no context" wrapper ──────────────────────────────────────────
export async function withRagFallback<T>(
  fn: () => T | Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`⚠️  RAG retrieval failed: ${(err as Error).message} — using fallback`);
    return fallback;
  }
}
