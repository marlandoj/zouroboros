#!/usr/bin/env bun
/**
 * ZOU-558 instinct-retrieve — blended-rank semantic retrieval for the instinct store.
 *
 * Queries Qdrant `instincts-semantic`, re-ranks by 0.5·cos + 0.3·confidence + 0.2·liveness,
 * and returns top-K instincts. Provides BOTH:
 *   - CLI mode: `bun instinct-retrieve.ts "query text" [--topk 5] [--keyword] [--json]`
 *   - Library mode: `import { blendedRetrieve, keywordRetrieve, rankBlended } from ...`
 *
 * Keyword baseline (substring on trigger) is exported for A/B comparison.
 * Falls back to keyword on Qdrant failure (no error surface to the caller).
 *
 * The MCP instinct_search tool and the CLI use the SAME rank function —
 * no bespoke benchmark path (eval-production parity).
 */
import { existsSync, readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import type { Instinct } from "./merge";

// Self-heal OPENAI key from /root/.zo_secrets when invoked under `env -i`.
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

const { embeddings: mcEmbeddings } = await import(
  "/home/workspace/Skills/zo-memory-system/scripts/model-client.ts"
);
const { liveness } = await import("./lifecycle");

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "instincts-semantic";
const STORE_PATH = process.env.INSTINCT_STORE_PATH ?? "/home/workspace/.zo/instincts/instincts.yaml";

// Blended-rank weights (env-tunable)
const W_SIM = parseFloat(process.env.INSTINCT_WEIGHT_SIM ?? "0.5");
const W_CONF = parseFloat(process.env.INSTINCT_WEIGHT_CONF ?? "0.3");
const W_LIVE = parseFloat(process.env.INSTINCT_WEIGHT_LIVE ?? "0.2");
const DEFAULT_TOPK = parseInt(process.env.INSTINCT_TOPK ?? "5", 10);

export interface RankedInstinct {
  inst_id: string;
  trigger: string;
  action: string;
  domain: string;
  confidence: number;
  last_seen: string;
  liveness: number;
  cosine_sim: number;
  blended_score: number;
}

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Rank raw Qdrant hits by blended score.
 * Exposed so CLI + MCP share the same ranker (eval-prod parity).
 */
export function rankBlended(
  hits: { score: number; payload: any }[],
  topK: number,
): RankedInstinct[] {
  const todayStr = today();
  return hits
    .map((h) => {
      const p = h.payload;
      const live = p.liveness_at_ingest ?? liveness(
        { last_seen: p.last_seen, confidence: p.confidence, reinforced_count: p.reinforced_count } as any,
        todayStr,
        30,
      );
      const blended = W_SIM * h.score + W_CONF * (p.confidence ?? 0.5) + W_LIVE * live;
      return {
        inst_id: p.inst_id,
        trigger: p.trigger,
        action: p.action,
        domain: p.domain,
        confidence: p.confidence ?? 0.5,
        last_seen: p.last_seen,
        liveness: Math.round(live * 100) / 100,
        cosine_sim: Math.round(h.score * 1000) / 1000,
        blended_score: Math.round(blended * 1000) / 1000,
      };
    })
    .sort((a, b) => b.blended_score - a.blended_score)
    .slice(0, topK);
}

/**
 * Semantic blended retrieval via Qdrant.
 * Falls back to keyword on failure (returns keyword results, no throw).
 */
export async function blendedRetrieve(
  query: string,
  topK: number = DEFAULT_TOPK,
): Promise<{ results: RankedInstinct[]; source: "semantic" | "keyword_fallback" }> {
  try {
    const embedResult = await mcEmbeddings(query);
    if (!embedResult.embedding?.length) throw new Error("empty embedding");

    const r = await fetch(
      `${QDRANT_URL}/collections/${COLLECTION}/points/search`,
      {
        method: "POST",
        headers: qHeaders(),
        body: JSON.stringify({
          vector: embedResult.embedding,
          limit: topK * 3, // over-fetch for re-ranking
          with_payload: true,
        }),
      },
    );
    if (!r.ok) throw new Error(`Qdrant search: ${r.status}`);
    const data = await r.json() as { result?: Array<{ score: number; payload: unknown }> };
    const hits: { score: number; payload: any }[] = (data.result || []).map(
      (p: any) => ({ score: p.score, payload: p.payload }),
    );
    if (hits.length === 0) throw new Error("no hits");
    return { results: rankBlended(hits, topK), source: "semantic" };
  } catch (err) {
    // Fallback to keyword — never surface the error
    return { results: keywordRetrieve(query, topK), source: "keyword_fallback" };
  }
}

/**
 * Keyword baseline — substring match on trigger + domain.
 * Exported for A/B comparison against the semantic arm.
 */
export function keywordRetrieve(
  query: string,
  topK: number = DEFAULT_TOPK,
): RankedInstinct[] {
  const todayStr = today();
  if (!existsSync(STORE_PATH)) return [];
  const raw = yamlLoad(readFileSync(STORE_PATH, "utf8"));
  const instincts: Instinct[] = Array.isArray((raw as any)?.instincts) ? (raw as any).instincts : [];
  const q = query.toLowerCase();
  const matches = instincts
    .filter((i) => {
      const t = (i.trigger || "").toLowerCase();
      const d = (i.domain || "").toLowerCase();
      return t.includes(q) || d.includes(q) || q.includes(d);
    })
    .slice(0, topK * 4)
    .map((i) => {
      const live = liveness(i as any, todayStr, 30);
      const score = W_CONF * i.confidence + W_LIVE * live;
      return {
        inst_id: i.id,
        trigger: i.trigger,
        action: i.action,
        domain: i.domain,
        confidence: i.confidence,
        last_seen: i.last_seen,
        liveness: Math.round(live * 100) / 100,
        cosine_sim: 0,
        blended_score: Math.round(score * 1000) / 1000,
      };
    })
    .sort((a, b) => b.blended_score - a.blended_score)
    .slice(0, topK);
  return matches;
}

// --- CLI ---
function printResults(results: RankedInstinct[], source: string, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify({ source, count: results.length, results }, null, 2));
    return;
  }
  console.log(`[${source}] ${results.length} instinct(s):`);
  for (const r of results) {
    console.log(`  ${r.inst_id}  score=${r.blended_score}  cos=${r.cosine_sim}  conf=${r.confidence}  live=${r.liveness}`);
    console.log(`    trigger: ${r.trigger.slice(0, 100)}`);
    console.log(`    action:  ${r.action.slice(0, 100)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const query = args.find((a) => !a.startsWith("-"));
  if (!query) {
    console.error("Usage: instinct-retrieve.ts <query> [--topk N] [--keyword] [--json]");
    process.exit(1);
  }
  const topKIdx = args.indexOf("--topk");
  const topK = topKIdx !== -1 ? parseInt(args[topKIdx + 1], 10) : DEFAULT_TOPK;
  const keywordOnly = args.includes("--keyword");
  const asJson = args.includes("--json");

  if (keywordOnly) {
    printResults(keywordRetrieve(query, topK), "keyword", asJson);
  } else {
    const { results, source } = await blendedRetrieve(query, topK);
    printResults(results, source, asJson);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
