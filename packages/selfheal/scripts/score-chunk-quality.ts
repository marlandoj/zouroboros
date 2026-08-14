#!/usr/bin/env bun
/**
 * score-chunk-quality.ts — M10 W4 t10
 *
 * Computes intrinsic chunk-quality metrics across Qdrant collections and
 * persists them to `chunk_quality` (migration 017) so the introspect
 * scorecard can surface a `chunk_health` dimension.
 *
 * Metrics (v1, computed from already-stored embeddings — no re-embedding):
 *   - DCC (Document Contextual Coherence): mean pairwise cosine similarity
 *     between chunks that share `payload.source_path`. High DCC = chunks
 *     within a doc are semantically related.
 *   - ICC (Intrachunk Cohesion proxy): mean cosine similarity between
 *     consecutive chunks (chunk_index N and N+1) within the same document.
 *     High ICC = chunks flow naturally; low = abrupt boundary cuts.
 *
 * Usage:
 *   bun packages/selfheal/scripts/score-chunk-quality.ts                  # all DEFAULT_COLLECTIONS
 *   bun packages/selfheal/scripts/score-chunk-quality.ts zouroboros-research shared-memory-facts
 *   bun packages/selfheal/scripts/score-chunk-quality.ts --json
 *   bun packages/selfheal/scripts/score-chunk-quality.ts --sample 300     # default 200
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getMemoryDbPath } from 'zouroboros-core';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://127.0.0.1:6333';
const DEFAULT_COLLECTIONS = [
  'zouroboros-research',
  'zouroboros-code',
  'shared-memory-facts',
  'commerce-a-knowledge',
  'code-docs',
];

interface ScrollPoint {
  id: string | number;
  payload?: Record<string, unknown>;
  vector?: number[];
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function scrollCollection(
  collection: string,
  sample: number,
): Promise<ScrollPoint[]> {
  const pts: ScrollPoint[] = [];
  let offset: string | number | undefined;
  while (pts.length < sample) {
    const body: Record<string, unknown> = {
      limit: Math.min(256, sample - pts.length),
      with_payload: true,
      with_vector: true,
    };
    if (offset !== undefined) body.offset = offset;
    const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant scroll failed (${collection}): ${res.status}`);
    const json = await res.json() as { result?: { points?: ScrollPoint[]; next_page_offset?: string | number } };
    const fetched = json.result?.points ?? [];
    if (fetched.length === 0) break;
    pts.push(...fetched);
    offset = json.result?.next_page_offset;
    if (offset === null || offset === undefined) break;
  }
  return pts;
}

interface ChunkQualityRow {
  collection: string;
  pointId: string;
  icc: number | null;
  dcc: number | null;
  chunkChars: number;
  sampleSize: number;
}

export interface CollectionQuality {
  collection: string;
  sampleSize: number;
  docsExamined: number;
  meanICC: number | null;
  meanDCC: number | null;
  perDocRows: ChunkQualityRow[];
}

/**
 * Pure function — exposed for unit testing without Qdrant.
 */
export function scoreFromPoints(
  collection: string,
  points: ScrollPoint[],
): CollectionQuality {
  // Group by source_path
  const byDoc = new Map<string, ScrollPoint[]>();
  for (const p of points) {
    const sp = String(p.payload?.source_path ?? p.payload?.source ?? 'unknown');
    if (!byDoc.has(sp)) byDoc.set(sp, []);
    byDoc.get(sp)!.push(p);
  }

  const rows: ChunkQualityRow[] = [];
  const dccAll: number[] = [];
  const iccAll: number[] = [];

  for (const [, docPoints] of byDoc) {
    if (docPoints.length < 2) continue;

    // Sort by chunk_index where present
    docPoints.sort((a, b) => {
      const ai = Number(a.payload?.chunk_index ?? 0);
      const bi = Number(b.payload?.chunk_index ?? 0);
      return ai - bi;
    });

    // DCC: mean pairwise cosine across all chunks in this doc.
    // Bound the pair count to keep large docs cheap (cap at 50 pairs).
    let dccSum = 0;
    let dccCount = 0;
    const cap = 50;
    outer: for (let i = 0; i < docPoints.length; i++) {
      for (let j = i + 1; j < docPoints.length; j++) {
        const va = docPoints[i].vector;
        const vb = docPoints[j].vector;
        if (!va || !vb) continue;
        dccSum += cosine(va, vb);
        dccCount++;
        if (dccCount >= cap) break outer;
      }
    }
    const dcc = dccCount > 0 ? dccSum / dccCount : null;
    if (dcc !== null) dccAll.push(dcc);

    // ICC proxy: mean cosine between consecutive chunks
    let iccSum = 0;
    let iccCount = 0;
    for (let i = 0; i < docPoints.length - 1; i++) {
      const va = docPoints[i].vector;
      const vb = docPoints[i + 1].vector;
      if (!va || !vb) continue;
      iccSum += cosine(va, vb);
      iccCount++;
    }
    const icc = iccCount > 0 ? iccSum / iccCount : null;
    if (icc !== null) iccAll.push(icc);

    // One row per representative chunk in this doc (the first one)
    const rep = docPoints[0];
    rows.push({
      collection,
      pointId: String(rep.id),
      icc,
      dcc,
      chunkChars: String(rep.payload?.content ?? '').length,
      sampleSize: docPoints.length,
    });
  }

  return {
    collection,
    sampleSize: points.length,
    docsExamined: byDoc.size,
    meanICC: iccAll.length ? iccAll.reduce((a, b) => a + b, 0) / iccAll.length : null,
    meanDCC: dccAll.length ? dccAll.reduce((a, b) => a + b, 0) / dccAll.length : null,
    perDocRows: rows,
  };
}

function ensureChunkQualityTable(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  execSync(
    `sqlite3 "${dbPath}" "` +
    `CREATE TABLE IF NOT EXISTS chunk_quality (` +
    `id TEXT PRIMARY KEY, ` +
    `collection TEXT NOT NULL, ` +
    `point_id TEXT NOT NULL, ` +
    `icc REAL, ` +
    `dcc REAL, ` +
    `chunk_chars INTEGER, ` +
    `sample_size INTEGER, ` +
    `measured_at INTEGER DEFAULT (strftime('%s','now'))` +
    `); ` +
    `CREATE INDEX IF NOT EXISTS idx_chunk_quality_collection ON chunk_quality(collection, measured_at DESC);"`,
    { encoding: 'utf-8', timeout: 5000 }
  );
}

function persistRows(dbPath: string, rows: ChunkQualityRow[]): void {
  if (!existsSync(dbPath) || rows.length === 0) return;
  ensureChunkQualityTable(dbPath);

  const values = rows.map(r => {
    const id = randomUUID();
    const collection = r.collection.replace(/'/g, "''");
    const pid = r.pointId.replace(/'/g, "''");
    const icc = r.icc === null ? 'NULL' : r.icc.toFixed(6);
    const dcc = r.dcc === null ? 'NULL' : r.dcc.toFixed(6);
    return `('${id}','${collection}','${pid}',${icc},${dcc},${r.chunkChars},${r.sampleSize})`;
  }).join(',');

  execSync(
    `sqlite3 "${dbPath}" "INSERT INTO chunk_quality(id,collection,point_id,icc,dcc,chunk_chars,sample_size) VALUES ${values}"`,
    { encoding: 'utf-8', timeout: 10000 }
  );
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const sampleIdx = args.indexOf('--sample');
  const sample = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1] || '200', 10) : 200;
  const dryRun = args.includes('--dry-run');

  const collectionArgs = args.filter(a => !a.startsWith('--') && a !== String(sample));
  const collections = collectionArgs.length > 0 ? collectionArgs : DEFAULT_COLLECTIONS;
  const dbPath = getMemoryDbPath();

  if (!json) {
    console.error(`[chunk-quality] Scoring ${collections.length} collection(s) | sample=${sample} | dry-run=${dryRun}`);
  }

  const results: CollectionQuality[] = [];
  for (const c of collections) {
    try {
      const points = await scrollCollection(c, sample);
      const q = scoreFromPoints(c, points);
      results.push(q);
      if (!dryRun) persistRows(dbPath, q.perDocRows);
      if (!json) {
        const dccStr = q.meanDCC === null ? 'n/a' : q.meanDCC.toFixed(3);
        const iccStr = q.meanICC === null ? 'n/a' : q.meanICC.toFixed(3);
        console.error(`  ${c.padEnd(24)} docs=${q.docsExamined} pts=${q.sampleSize} DCC=${dccStr} ICC=${iccStr}`);
      }
    } catch (err) {
      if (!json) console.error(`  ${c.padEnd(24)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[chunk-quality] fatal:', err);
    process.exit(1);
  });
}
