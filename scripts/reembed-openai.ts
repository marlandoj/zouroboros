#!/usr/bin/env bun
/**
 * reembed-openai.ts
 *
 * One-shot migration: re-embed all fact_embeddings and vault_embeddings
 * from nomic-embed-text (768d, Ollama) to text-embedding-3-small (1536d, OpenAI).
 *
 * Vector spaces are not compatible, so this is a hard cutover. Rows are
 * updated in place with new embedding BLOB + model tag.
 *
 * Usage:
 *   bun scripts/reembed-openai.ts --dry-run       # count only
 *   bun scripts/reembed-openai.ts                 # re-embed all
 *   bun scripts/reembed-openai.ts --db <path>     # single DB
 *   bun scripts/reembed-openai.ts --skip-vault    # facts only
 *
 * Defaults:
 *   - DBs: /home/workspace/.zo/memory/shared-facts.db, mimir.db, financial.db
 *   - Target: OpenAI text-embedding-3-small @ 1536d
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

const DEFAULT_DBS = [
  '/home/workspace/.zo/memory/shared-facts.db',
  '/home/workspace/.zo/memory/mimir.db',
  '/home/workspace/.zo/memory/financial.db',
];

const EMBED_MODEL = process.env.REEMBED_MODEL || 'text-embedding-3-small';
const EMBED_DIMS = Number(process.env.REEMBED_DIMS || 1536);
const BATCH_SIZE = Number(process.env.REEMBED_BATCH || 100);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipVault = args.includes('--skip-vault');
const skipFacts = args.includes('--skip-facts');
const dbIdx = args.indexOf('--db');
const dbTargets = dbIdx >= 0 ? [args[dbIdx + 1]] : DEFAULT_DBS;

const API_KEY = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY;
if (!dryRun && !API_KEY) {
  console.error('ERROR: OPENAI_API_KEY (or ZO_OPENAI_API_KEY) must be set');
  process.exit(1);
}

function serialize(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

async function embedBatch(inputs: string[]): Promise<number[][]> {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: inputs,
      dimensions: EMBED_DIMS,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { data: Array<{ embedding: number[]; index: number }> };
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

async function reembedFacts(db: Database, dbPath: string): Promise<{ done: number; failed: number }> {
  const rows = db
    .query(
      `SELECT fe.fact_id, f.text
       FROM fact_embeddings fe
       JOIN facts f ON f.id = fe.fact_id
       WHERE COALESCE(fe.model, '') != ?`,
    )
    .all(EMBED_MODEL) as Array<{ fact_id: string; text: string }>;

  console.log(`  facts: ${rows.length} rows to re-embed (${dbPath})`);
  if (dryRun || rows.length === 0) return { done: 0, failed: 0 };

  const update = db.prepare(
    `UPDATE fact_embeddings SET embedding = ?, model = ?, created_at = strftime('%s', 'now') WHERE fact_id = ?`,
  );

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => (r.text || '').slice(0, 8000));
    const vectors = await embedBatch(texts);
    if (vectors.length !== batch.length) {
      throw new Error(`batch size mismatch: got ${vectors.length} vectors for ${batch.length} inputs`);
    }
    for (const v of vectors) {
      if (v.length !== EMBED_DIMS) {
        throw new Error(`dimension mismatch: got ${v.length}d, expected ${EMBED_DIMS}d`);
      }
    }
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        update.run(serialize(vectors[j]), EMBED_MODEL, batch[j].fact_id);
      }
    })();
    done += batch.length;
    process.stderr.write(`    batch ${Math.ceil((i + BATCH_SIZE) / BATCH_SIZE)} / ${Math.ceil(rows.length / BATCH_SIZE)} → ${done}/${rows.length}\n`);
  }
  return { done, failed: 0 };
}

async function reembedVault(db: Database, dbPath: string): Promise<{ done: number; failed: number }> {
  const hasVault = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='vault_embeddings'`)
    .get();
  if (!hasVault) {
    return { done: 0, failed: 0 };
  }

  // Add model column if it doesn't exist (idempotent)
  try {
    db.run(`ALTER TABLE vault_embeddings ADD COLUMN model TEXT DEFAULT 'nomic-embed-text'`);
  } catch {
    // already exists
  }

  const rows = db
    .query(
      `SELECT file_path
       FROM vault_embeddings
       WHERE COALESCE(model, '') != ?`,
    )
    .all(EMBED_MODEL) as Array<{ file_path: string }>;

  console.log(`  vault: ${rows.length} rows to re-embed (${dbPath})`);
  if (dryRun || rows.length === 0) return { done: 0, failed: 0 };

  const update = db.prepare(
    `UPDATE vault_embeddings SET embedding_json = ?, model = ?, last_modified = ? WHERE file_path = ?`,
  );

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts: string[] = [];
    const kept: typeof batch = [];
    for (const row of batch) {
      if (!existsSync(row.file_path)) continue;
      try {
        const content = await Bun.file(row.file_path).text();
        texts.push(content.slice(0, 8000));
        kept.push(row);
      } catch {
        // skip unreadable
      }
    }
    if (kept.length === 0) continue;

    const vectors = await embedBatch(texts);
    if (vectors.length !== kept.length) {
      throw new Error(`vault batch size mismatch: got ${vectors.length} vectors for ${kept.length} inputs`);
    }
    for (const v of vectors) {
      if (v.length !== EMBED_DIMS) {
        throw new Error(`vault dimension mismatch: got ${v.length}d, expected ${EMBED_DIMS}d`);
      }
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let j = 0; j < kept.length; j++) {
        update.run(JSON.stringify(vectors[j]), EMBED_MODEL, now, kept[j].file_path);
      }
    })();
    done += kept.length;
    process.stderr.write(`    batch → vault ${done}/${rows.length}\n`);
  }
  return { done, failed: 0 };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`reembed-openai → model=${EMBED_MODEL} dims=${EMBED_DIMS} batch=${BATCH_SIZE}`);
  console.log(`mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log();

  let totalFacts = 0;
  let totalVault = 0;
  let totalFailed = 0;

  for (const dbPath of dbTargets) {
    if (!existsSync(dbPath)) {
      console.log(`SKIP (missing): ${dbPath}`);
      continue;
    }
    console.log(`→ ${dbPath}`);
    const db = new Database(dbPath);
    try {
      if (!skipFacts) {
        const f = await reembedFacts(db, dbPath);
        totalFacts += f.done;
        totalFailed += f.failed;
      }
      if (!skipVault) {
        const v = await reembedVault(db, dbPath);
        totalVault += v.done;
        totalFailed += v.failed;
      }
    } finally {
      db.close();
    }
    console.log();
  }

  console.log(`DONE: facts=${totalFacts}, vault=${totalVault}, failed=${totalFailed}`);
}

main().catch((err) => {
  console.error('FATAL: migration aborted — rerun will resume from unmigrated rows');
  console.error(err);
  process.exit(1);
});
