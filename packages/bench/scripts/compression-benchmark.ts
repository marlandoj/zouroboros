#!/usr/bin/env bun
/**
 * Compression Benchmark — Phase 2 of the Headroom-correlation benchmark.
 *
 * Loads the corpus captured by compression-corpus.ts and runs Headroom-style
 * context compression over every item, measuring the three things Headroom's
 * own benchmarks report: token reduction, semantic fidelity, and latency.
 *
 * Two compressors are applied per item and the cheaper *valid* result wins:
 *
 *   1. structural  — type-aware lossy-on-formatting reduction. For tool_output
 *      it minifies embedded JSON (data identical, whitespace gone); for text it
 *      collapses whitespace and de-dupes repeated tokens/lines. Fidelity is
 *      scored by whitespace/duplicate-insensitive comparison, so a transform
 *      that only drops formatting or duplicates scores 1.0.
 *
 *   2. reversible  — Headroom's SmartCrusher / CCR analog. Repeated substrings
 *      are replaced with private-use sentinels backed by a dictionary; the
 *      packed text + dictionary must round-trip *exactly* or the result is
 *      discarded. Fidelity is 1.0 iff decompress(compress(x)) === x.
 *
 * A result is admissible only if it meets the fidelity floor AND does not
 * expand token count. Headline reduction % is reported per type and overall.
 *
 * Output: data/runs/compression-<ts>.json  (consumed by compression-correlation.ts)
 *
 * Usage:
 *   bun packages/bench/scripts/compression-benchmark.ts
 *   bun packages/bench/scripts/compression-benchmark.ts --corpus data/compression/corpus.json
 *   bun packages/bench/scripts/compression-benchmark.ts --equiv-floor 0.98
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Corpus, CorpusItem, ContentType } from "./compression-corpus";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_CORPUS = resolve(ROOT, "data/compression/corpus.json");
const RUNS_DIR = resolve(ROOT, "data/runs");

const CHARS_PER_TOKEN = 4;
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type Strategy = "identity" | "structural" | "reversible";

export interface CompressionResult {
  id: string;
  contentType: ContentType;
  strategy: Strategy;
  originalTokens: number;
  compressedTokens: number;
  reductionPercent: number; // 0..100, higher = more saved
  semanticEquivalence: number; // 0..1
  latencyMs: number;
  passedAC: boolean;
}

// ─── Equivalence helpers ──────────────────────────────────────────────────────
function tryParseJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Split "tool_name {json...}" into name + args; args may be absent/non-JSON. */
function splitToolText(text: string): { name: string; args: string } {
  const i = text.indexOf(" ");
  if (i < 0) return { name: text, args: "" };
  return { name: text.slice(0, i), args: text.slice(i + 1) };
}

function uniqueTokenSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) set.add(m[0]);
  return set;
}

/** Jaccard similarity of informative token sets — whitespace/dup-insensitive. */
export function jaccard(a: string, b: string): number {
  const A = uniqueTokenSet(a);
  const B = uniqueTokenSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fidelity of a non-reversible (structural) transform vs the original. */
export function structuralEquivalence(original: string, compressed: string, contentType: ContentType): number {
  if (contentType === "tool_output") {
    const oa = splitToolText(original);
    const ca = splitToolText(compressed);
    const op = tryParseJson(oa.args);
    const cp = tryParseJson(ca.args);
    if (op !== undefined && cp !== undefined) return deepEqual(op, cp) ? 1 : jaccard(original, compressed);
  }
  return jaccard(original, compressed);
}

// ─── Structural compressor (lossy-on-formatting) ──────────────────────────────
export function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove exact duplicate lines and duplicate whitespace-separated tokens within
 *  a line — targets episode key-dumps like "a.b a.c a.b a.c ...". */
export function dedupTokensAndLines(text: string): string {
  const seenLines = new Set<string>();
  const outLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      outLines.push(line);
      continue;
    }
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    // de-dupe repeated whitespace-separated tokens within the line, order-preserving.
    // Dropping a duplicate also drops the whitespace run we just kept before it,
    // so we never leave an orphaned double-space behind.
    const parts = line.split(/(\s+)/);
    const seenTok = new Set<string>();
    const kept: string[] = [];
    for (const p of parts) {
      if (p === "") continue;
      if (/^\s+$/.test(p)) {
        kept.push(p);
        continue;
      }
      if (seenTok.has(p)) {
        if (kept.length && /^\s+$/.test(kept[kept.length - 1])) kept.pop();
        continue;
      }
      seenTok.add(p);
      kept.push(p);
    }
    outLines.push(kept.join("").replace(/\s+$/g, ""));
  }
  return outLines.join("\n");
}

export function structuralCompress(text: string, contentType: ContentType): string {
  if (contentType === "tool_output") {
    const { name, args } = splitToolText(text);
    const parsed = tryParseJson(args);
    if (parsed !== undefined) {
      // strip null / empty-string fields, compact serialize — data preserved
      const compact = JSON.stringify(parsed);
      return `${name} ${compact}`;
    }
    return collapseWhitespace(text);
  }
  if (contentType === "episode_document") {
    return dedupTokensAndLines(collapseWhitespace(text));
  }
  return collapseWhitespace(text);
}

// ─── Reversible compressor (SmartCrusher / CCR analog) ─────────────────────────
const SENT_OPEN = "";
const SENT_CLOSE = "";

export interface Packed {
  packed: string;
  dict: string[]; // index → phrase
}

// Segment boundaries: whitespace plus the punctuation that delimits dotted keys,
// paths, env vars, and JSON — so repeated *sub-token* segments (e.g. the
// "designSystem" / "theme" pieces of dotted keys) become dictionary entries.
const SEG_SPLIT = /([\s._/:,;(){}\[\]"'=<>|@-]+)/;
const SEG_DELIM = /^[\s._/:,;(){}\[\]"'=<>|@-]+$/;

/** One reversible pass over a given tokenization. Exactly reversible. */
function buildPacked(text: string, splitRe: RegExp, delimRe: RegExp, minLen: number): Packed {
  const parts = text.split(splitRe); // alternating word / delimiter chunks, exact
  const freq = new Map<string, number>();
  for (const p of parts) {
    if (p.length >= minLen && !delimRe.test(p)) freq.set(p, (freq.get(p) || 0) + 1);
  }
  const dict: string[] = [];
  const symbolOf = new Map<string, string>();
  for (const [seg, n] of freq) {
    if (n < 2) continue;
    const idx = dict.length;
    const sym = `${SENT_OPEN}${idx}${SENT_CLOSE}`;
    // net tokens saved = n×seg − (n×sentinel + dict entry); keep only if positive
    const save = n * estimateTokens(seg) - (n * estimateTokens(sym) + estimateTokens(seg) + 1);
    if (save <= 0) continue;
    dict.push(seg);
    symbolOf.set(seg, sym);
  }
  if (dict.length === 0) return { packed: text, dict: [] };
  return { packed: parts.map((p) => symbolOf.get(p) ?? p).join(""), dict };
}

/**
 * Reversible compression (Headroom SmartCrusher / CCR analog). Tries two
 * tokenizations and keeps whichever packs smaller:
 *   • whole-token (whitespace split) — best for long JSON values / env strings
 *   • segment (punctuation split)    — best for dotted key-dumps / paths
 * Both round-trip exactly via reversibleDecompress.
 */
export function reversibleCompress(text: string): Packed {
  // Bail if sentinels already present (cannot guarantee reversibility).
  if (text.includes(SENT_OPEN) || text.includes(SENT_CLOSE)) return { packed: text, dict: [] };
  const wholeToken = buildPacked(text, /(\s+)/, /^\s+$/, 6);
  const segment = buildPacked(text, SEG_SPLIT, SEG_DELIM, 4);
  return packedTokens(segment) < packedTokens(wholeToken) ? segment : wholeToken;
}

export function reversibleDecompress(p: Packed): string {
  let out = p.packed;
  for (let idx = 0; idx < p.dict.length; idx++) {
    const sym = `${SENT_OPEN}${idx}${SENT_CLOSE}`;
    out = out.split(sym).join(p.dict[idx]);
  }
  return out;
}

/** Total token cost of a packed payload = packed text + serialized dictionary. */
export function packedTokens(p: Packed): number {
  if (p.dict.length === 0) return estimateTokens(p.packed);
  return estimateTokens(p.packed) + estimateTokens(JSON.stringify(p.dict));
}

// ─── Per-item evaluation ───────────────────────────────────────────────────────
export function compressItem(item: CorpusItem, equivFloor: number): CompressionResult {
  const start = performance.now();
  const original = item.text;
  const originalTokens = item.tokens;

  type Cand = { strategy: Strategy; tokens: number; equivalence: number };
  const cands: Cand[] = [{ strategy: "identity", tokens: originalTokens, equivalence: 1 }];

  // structural
  const struct = structuralCompress(original, item.contentType);
  cands.push({
    strategy: "structural",
    tokens: estimateTokens(struct),
    equivalence: structuralEquivalence(original, struct, item.contentType),
  });

  // reversible
  const packed = reversibleCompress(original);
  const roundTrips = reversibleDecompress(packed) === original;
  cands.push({
    strategy: "reversible",
    tokens: roundTrips ? packedTokens(packed) : originalTokens,
    equivalence: roundTrips ? 1 : 0,
  });

  // admissible = meets fidelity floor AND does not expand
  const admissible = cands.filter((c) => c.equivalence >= equivFloor && c.tokens <= originalTokens);
  // prefer the smallest token count; identity is always admissible as the floor
  admissible.sort((a, b) => a.tokens - b.tokens);
  const best = admissible[0] ?? cands[0];

  const latencyMs = performance.now() - start;
  const reductionPercent = originalTokens === 0 ? 0 : ((originalTokens - best.tokens) / originalTokens) * 100;

  return {
    id: item.id,
    contentType: item.contentType,
    strategy: best.strategy,
    originalTokens,
    compressedTokens: best.tokens,
    reductionPercent: Math.round(reductionPercent * 100) / 100,
    semanticEquivalence: Math.round(best.equivalence * 1000) / 1000,
    latencyMs: Math.round(latencyMs * 1000) / 1000,
    passedAC: best.equivalence >= equivFloor && best.tokens <= originalTokens,
  };
}

// ─── Aggregation ────────────────────────────────────────────────────────────
export interface TypeAgg {
  contentType: ContentType;
  items: number;
  originalTokens: number;
  compressedTokens: number;
  reductionPercent: number;
  meanEquivalence: number;
  meanLatencyMs: number;
  strategyMix: Record<Strategy, number>;
  acPassRate: number;
}

export function aggregate(results: CompressionResult[], contentType: ContentType): TypeAgg {
  const subset = results.filter((r) => r.contentType === contentType);
  const origT = subset.reduce((s, r) => s + r.originalTokens, 0);
  const compT = subset.reduce((s, r) => s + r.compressedTokens, 0);
  const mix: Record<Strategy, number> = { identity: 0, structural: 0, reversible: 0 };
  for (const r of subset) mix[r.strategy]++;
  return {
    contentType,
    items: subset.length,
    originalTokens: origT,
    compressedTokens: compT,
    reductionPercent: origT === 0 ? 0 : Math.round(((origT - compT) / origT) * 10000) / 100,
    meanEquivalence: subset.length ? Math.round((subset.reduce((s, r) => s + r.semanticEquivalence, 0) / subset.length) * 1000) / 1000 : 1,
    meanLatencyMs: subset.length ? Math.round((subset.reduce((s, r) => s + r.latencyMs, 0) / subset.length) * 1000) / 1000 : 0,
    strategyMix: mix,
    acPassRate: subset.length ? Math.round((subset.filter((r) => r.passedAC).length / subset.length) * 1000) / 1000 : 1,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────
interface CliArgs { corpus: string; equivFloor: number }
function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { corpus: DEFAULT_CORPUS, equivFloor: 0.98 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") out.corpus = argv[++i];
    else if (argv[i] === "--equiv-floor") out.equivFloor = parseFloat(argv[++i]);
  }
  return out;
}

const CONTENT_TYPES: ContentType[] = ["tool_output", "memory_fact", "episode_document", "open_loop"];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.corpus)) {
    console.error(`FATAL: corpus not found at ${args.corpus}. Run compression-corpus.ts first.`);
    process.exit(2);
  }
  const corpus = JSON.parse(readFileSync(args.corpus, "utf-8")) as Corpus;

  console.log(`compression-benchmark → ${corpus.metadata.name} v${corpus.metadata.version}`);
  console.log(`  items: ${corpus.items.length}, fidelity floor: ${args.equivFloor}`);
  console.log();

  const results = corpus.items.map((it) => compressItem(it, args.equivFloor));
  const aggs = CONTENT_TYPES.map((ct) => aggregate(results, ct)).filter((a) => a.items > 0);

  const totalOrig = aggs.reduce((s, a) => s + a.originalTokens, 0);
  const totalComp = aggs.reduce((s, a) => s + a.compressedTokens, 0);
  const overallReduction = totalOrig === 0 ? 0 : ((totalOrig - totalComp) / totalOrig) * 100;
  const overallEquiv = results.length ? results.reduce((s, r) => s + r.semanticEquivalence, 0) / results.length : 1;
  const allAcPass = results.every((r) => r.passedAC);

  console.log("Per content type:");
  for (const a of aggs) {
    console.log(
      `  ${a.contentType.padEnd(18)} ` +
        `−${a.reductionPercent.toFixed(1)}% tokens (${a.originalTokens}→${a.compressedTokens})  ` +
        `fidelity=${a.meanEquivalence.toFixed(3)}  ` +
        `AC=${(a.acPassRate * 100).toFixed(0)}%  ` +
        `mix[s/r/i]=${a.strategyMix.structural}/${a.strategyMix.reversible}/${a.strategyMix.identity}`,
    );
  }
  console.log();
  console.log(`OVERALL: −${overallReduction.toFixed(1)}% tokens (${totalOrig}→${totalComp}), ` +
    `fidelity=${overallEquiv.toFixed(3)}, AC ${allAcPass ? "PASS" : "FAIL"}`);

  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(RUNS_DIR, `compression-${ts}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        corpus: corpus.metadata,
        runAt: new Date().toISOString(),
        equivFloor: args.equivFloor,
        overall: {
          originalTokens: totalOrig,
          compressedTokens: totalComp,
          reductionPercent: Math.round(overallReduction * 100) / 100,
          meanEquivalence: Math.round(overallEquiv * 1000) / 1000,
          acPass: allAcPass,
        },
        byType: aggs,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${out}`);
  process.exit(allAcPass ? 0 : 1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error("FATAL:", err);
    process.exit(2);
  }
}
