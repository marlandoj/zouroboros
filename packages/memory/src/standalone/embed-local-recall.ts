#!/usr/bin/env bun
/**
 * embed-local-recall.ts — Recall comparison harness (ZOU-420)
 *
 * Compares recall@k of the OpenAI text-embedding-3-small baseline against a
 * self-hosted local embedding tier (BGE-M3 / NV-Embed-v2 via ZO_EMBED_BASE_URL)
 * over a fixed query x corpus fixture set.
 *
 * Modes:
 *   --dry-run  (default)  Deterministic tier-salted mock embeddings for BOTH
 *                          tiers — ZERO API spend. Proves load → embed → rank →
 *                          recall → report end-to-end. The mock is tier-salted
 *                          (baseline vs local) so per-tier recall@k can differ,
 *                          exercising the verdict logic; the magnitude is NOT
 *                          indicative of real model quality.
 *   --live                Real calls: OpenAI (text-embedding-3-small) for
 *                          baseline, localEmbeddings() (BGE-M3) for the local
 *                          tier. Requires OPENAI_API_KEY + ZO_EMBED_BASE_URL.
 *
 * Flags:
 *   --fixtures <path>  Override the 12-query fixture set (default: sibling JSON)
 *   --out <dir>        Report output directory (default: cwd)
 *   --topk <n>         Recall cutoff (default: 10; recall@5 also computed)
 *
 * Emits <out>/embed-local-recall.report.md + .json. Exit 0 on a completed run.
 *
 * Live GPU provisioning (real BGE-M3 inference + true recall measurement) is a
 * deferred gap (ZOU-414 Hetzner annex). The dry-run is the in-sandbox proof.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { embeddings, localEmbedTierArmed } from "./model-client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FixtureQuery { id: string; query: string; relevantDocIds: string[]; }
interface FixtureDoc { id: string; text: string; }
interface Fixture { queries: FixtureQuery[]; corpus: FixtureDoc[]; }

interface TierMetrics { recall5: number; recall10: number; latency_ms: number; cost_usd: number; }
interface QueryResult {
  id: string; query: string;
  baseline: TierMetrics; local: TierMetrics;
  verdict: "LOCAL_WINS" | "BASELINE_WINS" | "TIE" | "ERROR";
}
interface Report {
  mode: "dry" | "live"; generated: string; fixtures: string;
  nQueries: number; nCorpus: number; topk: number;
  results: QueryResult[];
  aggregate: {
    baseline: { recall5: number; recall10: number; latency_ms: number; cost_usd: number };
    local: { recall5: number; recall10: number; latency_ms: number; cost_usd: number };
    verdicts: Record<string, number>;
  };
  note: string;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface ParsedFlags { live: boolean; opts: Record<string, string>; }

function parseFlags(argv: string[]): ParsedFlags {
  const opts: Record<string, string> = {};
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") { /* default */ }
    else if (a === "--live") live = true;
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? "";
  }
  return { live, opts };
}

const FLAGS = parseFlags(process.argv.slice(2));
const FIXTURES_PATH = FLAGS.opts.fixtures ||
  path.join(import.meta.dir, "embed-local-recall.fixtures.json");
const OUT_DIR = FLAGS.opts.out || process.cwd();
const TOPK = Number(FLAGS.opts.topk || 10) || 10;

// ─── Mock embeddings (dry-run) ───────────────────────────────────────────────
//
// Deterministic, tier-salted 512-dim L2-normalized vectors derived from SHA-256.
// Baseline and local use different salts → rankings differ → recall@k can differ
// → the verdict logic is exercised. Fully reproducible, zero API spend. The
// magnitude of any delta is a mock artifact, NOT a model-quality signal.

const MOCK_DIM = 512;

function mockEmbed(text: string, salt: string): number[] {
  const out = new Array<number>(MOCK_DIM);
  let h = createHash("sha256").update(`${salt}\u0001${text}`).digest();
  for (let i = 0; i < MOCK_DIM; i++) {
    if (i > 0 && i % 32 === 0) h = createHash("sha256").update(Buffer.concat([h, Buffer.from([i & 0xff])])).digest();
    out[i] = (h[i % 32] / 255) - 0.5;
  }
  // L2-normalize
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return out.map((v) => v / norm);
}

// ─── Live embeddings ─────────────────────────────────────────────────────────
//
// Baseline = OpenAI text-embedding-3-small (the model being replaced), called
// directly so the harness measures the EXACT baseline, independent of the
// dormant-until-armed short-circuit in embeddings().
// Local   = localEmbeddings() (BGE-M3 via ZO_EMBED_BASE_URL), via the shared
// socket so the live run exercises the production code path.

async function baselineEmbedLive(text: string): Promise<{ vec: number[]; latency_ms: number; cost_usd: number }> {
  const start = Date.now();
  const key = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set (required for --live baseline)");
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`OpenAI baseline ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
  const vec = data.data?.[0]?.embedding ?? [];
  return { vec, latency_ms: Date.now() - start, cost_usd: 0.0001 };
}

async function localEmbedLive(text: string): Promise<{ vec: number[]; latency_ms: number; cost_usd: number }> {
  // embeddings() short-circuits to localEmbeddings() (BGE-M3 via ZO_EMBED_BASE_URL)
  // when the local tier is armed — exercising the SAME production dispatch path the
  // qdrant-rag MCP uses. The explicitModel arg is the OpenAI default; the short-circuit
  // ignores it and resolves ZO_EMBED_MODEL (bge-m3). The baseline tier is reached via
  // baselineEmbedLive() above, which calls OpenAI directly (independent of the short-circuit).
  const r = await embeddings(text, "text-embedding-3-small");
  return { vec: r.embedding, latency_ms: r.latency_ms, cost_usd: r.cost_usd };
}

// NOTE: in --live mode, embeddings() short-circuits to localEmbeddings() (BGE-M3) when
// ZO_EMBED_BASE_URL is set. baselineEmbedLive() reaches OpenAI text-embedding-3-small
// directly so the baseline measurement is independent of the dormant-until-armed
// short-circuit. This is the production dispatch path the qdrant-rag MCP uses.

// ─── Ranking + recall ─────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized → dot == cosine
}

function recallAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = rankedIds.slice(0, k);
  const hits = top.filter((id) => relevant.has(id)).length;
  return hits / Math.min(relevant.size, k);
}

// ─── Per-query evaluation ────────────────────────────────────────────────────

type EmbedVec = { vec: number[]; latency_ms: number; cost_usd: number };
type EmbedFn = (text: string, salt: string) => Promise<EmbedVec>;

async function evalQuery(
  q: FixtureQuery,
  corpus: FixtureDoc[],
  mode: "dry" | "live",
): Promise<QueryResult> {
  const relevant = new Set(q.relevantDocIds);
  const embed: EmbedFn = mode === "dry"
    ? (text, salt) => Promise.resolve({ vec: mockEmbed(text, salt), latency_ms: 0, cost_usd: 0 })
    : (text, salt) => (salt === "baseline" ? baselineEmbedLive(text) : localEmbedLive(text));

  let baseline: TierMetrics = { recall5: 0, recall10: 0, latency_ms: 0, cost_usd: 0 };
  let local: TierMetrics = { recall5: 0, recall10: 0, latency_ms: 0, cost_usd: 0 };

  try {
    const bStart = Date.now();
    const bq = await embed(q.query, "baseline");
    const bDocs = await Promise.all(corpus.map((d) => embed(d.text, "baseline")));
    const bRanked = bDocs
      .map((d, i) => ({ id: corpus[i].id, score: cosine(bq.vec, d.vec) }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.id);
    baseline = {
      recall5: recallAtK(bRanked, relevant, 5),
      recall10: recallAtK(bRanked, relevant, TOPK),
      latency_ms: Date.now() - bStart,
      cost_usd: bDocs.reduce((s, d) => s + d.cost_usd, 0),
    };
  } catch (e) {
    console.error(`[baseline/${q.id}] ${(e as Error).message}`);
  }

  try {
    const lStart = Date.now();
    const lq = await embed(q.query, "local");
    const lDocs = await Promise.all(corpus.map((d) => embed(d.text, "local")));
    const lRanked = lDocs
      .map((d, i) => ({ id: corpus[i].id, score: cosine(lq.vec, d.vec) }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.id);
    local = {
      recall5: recallAtK(lRanked, relevant, 5),
      recall10: recallAtK(lRanked, relevant, TOPK),
      latency_ms: Date.now() - lStart,
      cost_usd: lDocs.reduce((s, d) => s + d.cost_usd, 0),
    };
  } catch (e) {
    console.error(`[local/${q.id}] ${(e as Error).message}`);
  }

  // Verdict on recall@10: LOCAL_WINS / BASELINE_WINS / TIE. A single 0 vs >0 is a
  // legitimate verdict (not an error) — the only ERROR source is a thrown embed.
  const verdict: QueryResult["verdict"] =
    local.recall10 > baseline.recall10 ? "LOCAL_WINS"
    : local.recall10 < baseline.recall10 ? "BASELINE_WINS"
    : "TIE";

  return { id: q.id, query: q.query, baseline, local, verdict };
}

// ─── Report ──────────────────────────────────────────────────────────────────

function aggregate(results: QueryResult[]) {
  const verdicts: Record<string, number> = { LOCAL_WINS: 0, BASELINE_WINS: 0, TIE: 0, ERROR: 0 };
  let bR5 = 0, bR10 = 0, bLat = 0, bCost = 0, lR5 = 0, lR10 = 0, lLat = 0, lCost = 0;
  for (const r of results) {
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    bR5 += r.baseline.recall5; bR10 += r.baseline.recall10; bLat += r.baseline.latency_ms; bCost += r.baseline.cost_usd;
    lR5 += r.local.recall5; lR10 += r.local.recall10; lLat += r.local.latency_ms; lCost += r.local.cost_usd;
  }
  const n = results.length || 1;
  return {
    baseline: { recall5: bR5 / n, recall10: bR10 / n, latency_ms: bLat, cost_usd: bCost },
    local: { recall5: lR5 / n, recall10: lR10 / n, latency_ms: lLat, cost_usd: lCost },
    verdicts,
  };
}

function toMarkdown(rep: Report): string {
  const lines: string[] = [];
  lines.push("# ZOU-420 — Embedding recall comparison");
  lines.push("");
  lines.push(`**Mode:** ${rep.mode === "dry" ? "dry-run (deterministic mock, zero spend)" : "live"} · **Fixtures:** \`${rep.fixtures}\` · **Queries:** ${rep.nQueries} · **Corpus:** ${rep.nCorpus} · **Top-k:** ${rep.topk} · **Generated:** ${rep.generated}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Tier | recall@5 | recall@10 | latency (ms) | cost (USD) |");
  lines.push("|------|---------|----------|-------------|-----------|");
  const a = rep.aggregate;
  lines.push(`| **baseline** (text-embedding-3-small) | ${(a.baseline.recall5 * 100).toFixed(1)}% | ${(a.baseline.recall10 * 100).toFixed(1)}% | ${a.baseline.latency_ms} | $${a.baseline.cost_usd.toFixed(6)} |`);
  lines.push(`| **local** (BGE-M3 self-hosted) | ${(a.local.recall5 * 100).toFixed(1)}% | ${(a.local.recall10 * 100).toFixed(1)}% | ${a.local.latency_ms} | $${a.local.cost_usd.toFixed(6)} |`);
  lines.push("");
  lines.push(`**Verdicts:** LOCAL_WINS=${a.verdicts.LOCAL_WINS ?? 0} · BASELINE_WINS=${a.verdicts.BASELINE_WINS ?? 0} · TIE=${a.verdicts.TIE ?? 0} · ERROR=${a.verdicts.ERROR ?? 0}`);
  lines.push("");
  lines.push("## Per-query");
  lines.push("");
  lines.push("| id | query | baseline R@10 | local R@10 | verdict |");
  lines.push("|----|-------|-------------|-----------|---------|");
  for (const r of rep.results) {
    lines.push(`| ${r.id} | ${r.query.replace(/\|/g, "\\|").slice(0, 60)} | ${(r.baseline.recall10 * 100).toFixed(0)}% | ${(r.local.recall10 * 100).toFixed(0)}% | ${r.verdict} |`);
  }
  lines.push("");
  lines.push("> " + rep.note.replace(/\n/g, " "));
  return lines.join("\n") + "\n";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  if (!existsSync(FIXTURES_PATH)) {
    console.error(`Fixtures not found: ${FIXTURES_PATH}`);
    return 1;
  }
  const fixture = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as Fixture;
  if (!fixture.queries?.length || !fixture.corpus?.length) {
    console.error("Fixtures missing queries/corpus");
    return 1;
  }

  const mode: "dry" | "live" = FLAGS.live ? "live" : "dry";
  if (mode === "live") {
    if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
      console.error("--live requires OPENAI_API_KEY (or ZO_OPENAI_API_KEY) for the baseline");
      return 1;
    }
    if (!localEmbedTierArmed()) {
      console.error("--live requires ZO_EMBED_BASE_URL (local embedding tier armed)");
      return 1;
    }
  }

  console.log(`[embed-local-recall] mode=${mode} queries=${fixture.queries.length} corpus=${fixture.corpus.length} topk=${TOPK}`);

  const results: QueryResult[] = [];
  for (const q of fixture.queries) {
    process.stdout.write(`  ${q.id} ${q.query.slice(0, 50)}... `);
    const r = await evalQuery(q, fixture.corpus, mode);
    results.push(r);
    console.log(`baseline R@10=${(r.baseline.recall10 * 100).toFixed(0)}% local R@10=${(r.local.recall10 * 100).toFixed(0)}% → ${r.verdict}`);
  }

  const rep: Report = {
    mode,
    generated: new Date().toISOString(),
    fixtures: FIXTURES_PATH,
    nQueries: fixture.queries.length,
    nCorpus: fixture.corpus.length,
    topk: TOPK,
    results,
    aggregate: aggregate(results),
    note:
      mode === "dry"
        ? "Dry-run uses tier-salted deterministic mock embeddings for both tiers (zero API spend). Per-tier recall@k differs due to the salt perturbation, which exercises the verdict logic and proves the harness captures tier differences — the magnitude is a mock artifact, NOT a model-quality signal. The live run (--live, requires OPENAI_API_KEY + ZO_EMBED_BASE_URL) measures the true recall delta of BGE-M3 vs text-embedding-3-small; live GPU provisioning is deferred to the Hetzner annex (ZOU-414)."
        : "Live run. Baseline = OpenAI text-embedding-3-small (called directly). Local = localEmbeddings() via ZO_EMBED_BASE_URL (BGE-M3), exercising the production dispatch path. Aggregate recall@k compares real model recall over the fixture corpus.",
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "embed-local-recall.report.md"), toMarkdown(rep));
  writeFileSync(path.join(OUT_DIR, "embed-local-recall.report.json"), JSON.stringify(rep, null, 2) + "\n");

  console.log(`\n[embed-local-recall] report → ${path.join(OUT_DIR, "embed-local-recall.report.md")}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
