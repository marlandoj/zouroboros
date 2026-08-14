#!/usr/bin/env bun
/**
 * Compression Corpus Capture — Phase 1 of the Headroom-correlation benchmark.
 *
 * Snapshots representative real content from Zouroboros's live memory store
 * (shared-facts.db) across the content types that actually consume the context
 * window at runtime: tool-call payloads, memory facts, episodic documents, and
 * open-loop summaries. Each item is tokenized with Zouroboros's own budget
 * estimator (chars/4) so downstream compression deltas are measured the way the
 * runtime accounts for tokens — not against some unrelated tokenizer.
 *
 * The corpus is the fixed input for Phase 2 (compression-benchmark.ts) and
 * Phase 3 (compression-correlation.ts), so capture is deterministic: items are
 * stratified across each type's length distribution rather than sampled
 * randomly, giving a stable, reproducible mix of light and heavy content.
 *
 * Output: data/compression/corpus.json
 *
 * Usage:
 *   bun packages/bench/scripts/compression-corpus.ts
 *   bun packages/bench/scripts/compression-corpus.ts --db /path/to/shared-facts.db
 *   bun packages/bench/scripts/compression-corpus.ts --per-type 60
 *
 * Read-only: the DB is opened readonly and never mutated.
 */
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "data/compression");
const OUT_PATH = resolve(OUT_DIR, "corpus.json");

const DEFAULT_DB =
  process.env.ZOUROBOROS_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

// ─── Token estimation ───────────────────────────────────────────────────────
// Mirrors packages/memory/src/context-budget.ts so compression savings are
// measured in the same unit the runtime budgets against.
const CHARS_PER_TOKEN = 4;
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Types ──────────────────────────────────────────────────────────────────
export type ContentType =
  | "tool_output"
  | "memory_fact"
  | "episode_document"
  | "open_loop";

export interface CorpusItem {
  id: string; // `${contentType}:${sourceId}`
  contentType: ContentType;
  sourceTable: string;
  sourceId: string;
  text: string;
  charLength: number;
  tokens: number;
}

export interface CorpusTypeStats {
  contentType: ContentType;
  itemCount: number;
  totalChars: number;
  totalTokens: number;
  avgTokens: number;
  minTokens: number;
  maxTokens: number;
}

export interface Corpus {
  metadata: {
    name: string;
    version: string;
    capturedAt: string;
    dbPath: string;
    perType: number;
    charsPerToken: number;
  };
  stats: CorpusTypeStats[];
  items: CorpusItem[];
}

// ─── Sampling (pure, unit-testable) ───────────────────────────────────────────
/**
 * Stratified pick of `n` items evenly spaced across a list pre-sorted by length
 * (descending). Deterministic and representative: spans the whole distribution
 * from heaviest to lightest instead of biasing toward either end.
 */
export function stratifiedSample<T>(sortedDesc: T[], n: number): T[] {
  if (n <= 0) return [];
  if (sortedDesc.length <= n) return sortedDesc.slice();
  const out: T[] = [];
  const step = sortedDesc.length / n;
  for (let i = 0; i < n; i++) out.push(sortedDesc[Math.floor(i * step)]);
  return out;
}

export function computeTypeStats(items: CorpusItem[], contentType: ContentType): CorpusTypeStats {
  const subset = items.filter((it) => it.contentType === contentType);
  const tokens = subset.map((it) => it.tokens);
  return {
    contentType,
    itemCount: subset.length,
    totalChars: subset.reduce((s, it) => s + it.charLength, 0),
    totalTokens: tokens.reduce((s, t) => s + t, 0),
    avgTokens: subset.length ? Math.round(tokens.reduce((s, t) => s + t, 0) / subset.length) : 0,
    minTokens: subset.length ? Math.min(...tokens) : 0,
    maxTokens: subset.length ? Math.max(...tokens) : 0,
  };
}

// ─── Capture ──────────────────────────────────────────────────────────────────
interface RawRow {
  sourceId: string;
  text: string;
}

function toItem(contentType: ContentType, sourceTable: string, row: RawRow): CorpusItem {
  const text = row.text;
  return {
    id: `${contentType}:${row.sourceId}`,
    contentType,
    sourceTable,
    sourceId: row.sourceId,
    text,
    charLength: text.length,
    tokens: estimateTokens(text),
  };
}

/** Pull every non-empty row for a type, sort by length desc, stratify to perType. */
function captureType(
  db: Database,
  contentType: ContentType,
  sourceTable: string,
  sql: string,
  perType: number,
): CorpusItem[] {
  const rows = db.query(sql).all() as Array<{ source_id: string; text: string | null }>;
  const raw: RawRow[] = rows
    .filter((r) => r.text != null && r.text.trim().length > 0)
    .map((r) => ({ sourceId: r.source_id, text: r.text as string }));
  raw.sort((a, b) => b.text.length - a.text.length);
  return stratifiedSample(raw, perType).map((r) => toItem(contentType, sourceTable, r));
}

export function captureCorpus(db: Database, perType: number): CorpusItem[] {
  const items: CorpusItem[] = [];

  // tool_output — the JSON payload of a tool call as stored for replay/eval.
  items.push(
    ...captureType(
      db,
      "tool_output",
      "tool_evals",
      `SELECT id AS source_id, (tool_name || ' ' || COALESCE(tool_args,'')) AS text
       FROM tool_evals WHERE tool_args IS NOT NULL AND length(tool_args) > 0`,
      perType,
    ),
  );

  // memory_fact — the full FTS context text of a stored fact.
  items.push(
    ...captureType(
      db,
      "memory_fact",
      "facts",
      `SELECT id AS source_id, text AS text FROM facts WHERE text IS NOT NULL`,
      perType,
    ),
  );

  // episode_document — episodic narrative documents (the heaviest content type).
  items.push(
    ...captureType(
      db,
      "episode_document",
      "episode_documents",
      `SELECT episode_id AS source_id, text AS text FROM episode_documents`,
      perType,
    ),
  );

  // open_loop — title + summary of a tracked open loop.
  items.push(
    ...captureType(
      db,
      "open_loop",
      "open_loops",
      `SELECT id AS source_id, (title || ' — ' || summary) AS text FROM open_loops`,
      perType,
    ),
  );

  return items;
}

// ─── CLI ────────────────────────────────────────────────────────────────────
interface CliArgs { db: string; perType: number }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { db: DEFAULT_DB, perType: 40 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") out.db = argv[++i];
    else if (argv[i] === "--per-type") out.perType = parseInt(argv[++i], 10);
  }
  return out;
}

const CONTENT_TYPES: ContentType[] = ["tool_output", "memory_fact", "episode_document", "open_loop"];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    console.error(`FATAL: DB not found at ${args.db}`);
    process.exit(2);
  }

  console.log(`compression-corpus → capturing from ${args.db}`);
  console.log(`  per-type target: ${args.perType}, token unit: chars/${CHARS_PER_TOKEN}`);
  console.log();

  const db = new Database(args.db, { readonly: true });
  let items: CorpusItem[];
  try {
    items = captureCorpus(db, args.perType);
  } finally {
    db.close();
  }

  const stats = CONTENT_TYPES.map((ct) => computeTypeStats(items, ct)).filter((s) => s.itemCount > 0);

  const corpus: Corpus = {
    metadata: {
      name: "zouroboros-compression-corpus",
      version: "1.0",
      capturedAt: new Date().toISOString(),
      dbPath: args.db,
      perType: args.perType,
      charsPerToken: CHARS_PER_TOKEN,
    },
    stats,
    items,
  };

  for (const s of stats) {
    console.log(
      `  ${s.contentType.padEnd(18)} n=${String(s.itemCount).padStart(3)}  ` +
        `tokens=${String(s.totalTokens).padStart(6)}  ` +
        `avg=${String(s.avgTokens).padStart(4)}  min=${s.minTokens}  max=${s.maxTokens}`,
    );
  }
  const grandTokens = stats.reduce((s, t) => s + t.totalTokens, 0);
  console.log();
  console.log(`  total items: ${items.length}, total baseline tokens: ${grandTokens}`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(corpus, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error("FATAL:", err);
    process.exit(2);
  }
}
