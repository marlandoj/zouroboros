#!/usr/bin/env bun
/**
 * monitor-rag-drift.ts — M10 W4 t11
 *
 * Online RAG drift monitor. Tracks two signals per Qdrant collection:
 *
 *  1. Corpus size delta — collection point count vs last measurement.
 *     Large unexpected jumps may indicate re-index drift or stale data.
 *
 *  2. Embedding centroid drift — cosine distance between the current
 *     mean-vector (over a 200-point sample) and the last-recorded centroid.
 *     ≥ 0.05 → DRIFTING; ≥ 0.15 → BREACH.
 *
 * On the first run for a collection, status = BASELINE_CAPTURED (no prior).
 *
 * Persistence: rag_drift_metrics table (migration 018), with the same
 * defensive CREATE TABLE IF NOT EXISTS pattern used elsewhere in W3/W4.
 *
 * Operationalization: weekly Sunday agent (registered post-merge).
 *
 * Usage:
 *   bun packages/selfheal/scripts/monitor-rag-drift.ts
 *   bun packages/selfheal/scripts/monitor-rag-drift.ts zouroboros-research
 *   bun packages/selfheal/scripts/monitor-rag-drift.ts --json
 *   bun packages/selfheal/scripts/monitor-rag-drift.ts --sample 300
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

export type DriftStatus = 'BASELINE_CAPTURED' | 'OK' | 'DRIFTING' | 'BREACH';

export interface DriftThresholds {
  driftWarn: number;     // cosine distance threshold for DRIFTING
  driftBreach: number;   // cosine distance threshold for BREACH
  sizeWarnPct: number;   // |size delta| / prior threshold for DRIFTING
  sizeBreachPct: number; // |size delta| / prior threshold for BREACH
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  driftWarn: 0.05,
  driftBreach: 0.15,
  sizeWarnPct: 0.20,
  sizeBreachPct: 0.50,
};

export function classifyDrift(
  embeddingDistance: number | null,
  priorSize: number | null,
  currentSize: number,
  thresholds = DEFAULT_THRESHOLDS,
): { status: DriftStatus; reason: string } {
  if (priorSize === null || embeddingDistance === null) {
    return { status: 'BASELINE_CAPTURED', reason: 'first measurement — baseline saved' };
  }
  const sizeDelta = currentSize - priorSize;
  const sizePct = priorSize > 0 ? Math.abs(sizeDelta) / priorSize : 0;

  if (embeddingDistance >= thresholds.driftBreach || sizePct >= thresholds.sizeBreachPct) {
    return {
      status: 'BREACH',
      reason: `embedding_dist=${embeddingDistance.toFixed(4)} size_pct=${(sizePct * 100).toFixed(1)}%`,
    };
  }
  if (embeddingDistance >= thresholds.driftWarn || sizePct >= thresholds.sizeWarnPct) {
    return {
      status: 'DRIFTING',
      reason: `embedding_dist=${embeddingDistance.toFixed(4)} size_pct=${(sizePct * 100).toFixed(1)}%`,
    };
  }
  return {
    status: 'OK',
    reason: `embedding_dist=${embeddingDistance.toFixed(4)} size_pct=${(sizePct * 100).toFixed(1)}%`,
  };
}

export function meanVector(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function getCollectionSize(collection: string): Promise<number> {
  const res = await fetch(`${QDRANT_URL}/collections/${collection}`);
  if (!res.ok) throw new Error(`Qdrant collection info failed: ${res.status}`);
  const json = await res.json() as { result?: { points_count?: number; vectors_count?: number } };
  return json.result?.points_count ?? json.result?.vectors_count ?? 0;
}

async function sampleVectors(collection: string, sample: number): Promise<number[][]> {
  const vectors: number[][] = [];
  let offset: string | number | undefined;
  while (vectors.length < sample) {
    const body: Record<string, unknown> = {
      limit: Math.min(256, sample - vectors.length),
      with_payload: false,
      with_vector: true,
    };
    if (offset !== undefined) body.offset = offset;
    const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`scroll failed: ${res.status}`);
    const json = await res.json() as {
      result?: { points?: Array<{ vector?: number[] }>; next_page_offset?: string | number }
    };
    const fetched = json.result?.points ?? [];
    for (const p of fetched) {
      if (p.vector) vectors.push(p.vector);
    }
    offset = json.result?.next_page_offset;
    if (!offset || fetched.length === 0) break;
  }
  return vectors;
}

interface PriorMeasurement {
  centroid: number[] | null;
  size: number;
}

function ensureDriftTable(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  execSync(
    `sqlite3 "${dbPath}" "` +
    `CREATE TABLE IF NOT EXISTS rag_drift_metrics (` +
    `id TEXT PRIMARY KEY, ` +
    `collection TEXT NOT NULL, ` +
    `embedding_drift REAL, ` +
    `corpus_size_delta INTEGER, ` +
    `retrieval_signal REAL, ` +
    `baseline INTEGER NOT NULL DEFAULT 0, ` +
    `status TEXT NOT NULL CHECK(status IN ('BASELINE_CAPTURED','OK','DRIFTING','BREACH')), ` +
    `detail TEXT, ` +
    `measured_at INTEGER DEFAULT (strftime('%s','now'))` +
    `); ` +
    `CREATE INDEX IF NOT EXISTS idx_rag_drift_collection ON rag_drift_metrics(collection, measured_at DESC); ` +
    `CREATE INDEX IF NOT EXISTS idx_rag_drift_status ON rag_drift_metrics(status, measured_at DESC); ` +
    `CREATE TABLE IF NOT EXISTS rag_drift_baseline (` +
    `collection TEXT PRIMARY KEY, ` +
    `centroid_json TEXT, ` +
    `size INTEGER, ` +
    `updated_at INTEGER DEFAULT (strftime('%s','now'))` +
    `);"`,
    { encoding: 'utf-8', timeout: 5000 }
  );
}

function loadPrior(dbPath: string, collection: string): PriorMeasurement | null {
  if (!existsSync(dbPath)) return null;
  ensureDriftTable(dbPath);
  try {
    const safe = collection.replace(/'/g, "''");
    // Default sqlite3 separator is '|'. JSON arrays of numbers never contain
    // '|', so this is safe; we split only on the last '|' for robustness.
    const out = execSync(
      `sqlite3 "${dbPath}" "SELECT centroid_json || '#' || size FROM rag_drift_baseline WHERE collection='${safe}'"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (!out) return null;
    const lastHash = out.lastIndexOf('#');
    if (lastHash < 0) return null;
    const centroidJson = out.slice(0, lastHash);
    const sizeStr = out.slice(lastHash + 1);
    const size = parseInt(sizeStr ?? '0', 10) || 0;
    let centroid: number[] | null = null;
    if (centroidJson) {
      try { centroid = JSON.parse(centroidJson) as number[]; } catch { centroid = null; }
    }
    return { centroid, size };
  } catch {
    return null;
  }
}

function saveBaseline(dbPath: string, collection: string, centroid: number[], size: number): void {
  if (!existsSync(dbPath)) return;
  ensureDriftTable(dbPath);
  const safe = collection.replace(/'/g, "''");
  // Round centroid to 6 decimals to limit row size; it's just a baseline.
  const json = JSON.stringify(centroid.map(x => Math.round(x * 1e6) / 1e6)).replace(/'/g, "''");
  execSync(
    `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO rag_drift_baseline(collection,centroid_json,size,updated_at) VALUES('${safe}','${json}',${size},strftime('%s','now'))"`,
    { encoding: 'utf-8', timeout: 10000 }
  );
}

function persistMetric(
  dbPath: string,
  collection: string,
  drift: number | null,
  sizeDelta: number,
  status: DriftStatus,
  detail: string,
  isBaseline: boolean,
): void {
  if (!existsSync(dbPath)) return;
  ensureDriftTable(dbPath);
  const id = randomUUID();
  const safe = collection.replace(/'/g, "''");
  const driftSql = drift === null ? 'NULL' : drift.toFixed(6);
  const detailSafe = detail.replace(/'/g, "''").slice(0, 500);
  execSync(
    `sqlite3 "${dbPath}" "INSERT INTO rag_drift_metrics(id,collection,embedding_drift,corpus_size_delta,baseline,status,detail) ` +
    `VALUES('${id}','${safe}',${driftSql},${sizeDelta},${isBaseline ? 1 : 0},'${status}','${detailSafe}')"`,
    { encoding: 'utf-8', timeout: 5000 }
  );
}

interface CollectionResult {
  collection: string;
  status: DriftStatus;
  embeddingDrift: number | null;
  sizeDelta: number;
  currentSize: number;
  detail: string;
}

async function monitorCollection(
  collection: string,
  dbPath: string,
  sample: number,
  dryRun: boolean,
): Promise<CollectionResult> {
  const currentSize = await getCollectionSize(collection);
  const sampled = await sampleVectors(collection, sample);
  const centroid = meanVector(sampled);

  const prior = loadPrior(dbPath, collection);
  const drift = (prior?.centroid && centroid) ? cosineDistance(prior.centroid, centroid) : null;
  const priorSize = prior?.size ?? null;
  const sizeDelta = priorSize === null ? 0 : currentSize - priorSize;

  const { status, reason } = classifyDrift(drift, priorSize, currentSize);
  const isBaseline = status === 'BASELINE_CAPTURED';

  if (!dryRun) {
    persistMetric(dbPath, collection, drift, sizeDelta, status, reason, isBaseline);
    if (centroid) saveBaseline(dbPath, collection, centroid, currentSize);
  }

  return { collection, status, embeddingDrift: drift, sizeDelta, currentSize, detail: reason };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const sampleIdx = args.indexOf('--sample');
  const sample = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1] || '200', 10) : 200;

  const collectionArgs = args.filter(a => !a.startsWith('--') && a !== String(sample));
  const collections = collectionArgs.length > 0 ? collectionArgs : DEFAULT_COLLECTIONS;
  const dbPath = getMemoryDbPath();

  if (!json) {
    console.error(`[rag-drift] Monitoring ${collections.length} collection(s) | sample=${sample} | dry-run=${dryRun}`);
  }

  const results: CollectionResult[] = [];
  for (const c of collections) {
    try {
      const r = await monitorCollection(c, dbPath, sample, dryRun);
      results.push(r);
      if (!json) {
        const driftStr = r.embeddingDrift === null ? 'n/a' : r.embeddingDrift.toFixed(4);
        console.error(`  ${c.padEnd(24)} ${r.status.padEnd(20)} drift=${driftStr} Δsize=${r.sizeDelta} (${r.currentSize}) ${r.detail}`);
      }
    } catch (err) {
      if (!json) console.error(`  ${c.padEnd(24)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (json) console.log(JSON.stringify(results, null, 2));

  const breached = results.filter(r => r.status === 'BREACH').length;
  if (breached > 0) {
    if (!json) console.error(`[rag-drift] ${breached} collection(s) BREACH — investigate`);
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[rag-drift] fatal:', err);
    process.exit(1);
  });
}
