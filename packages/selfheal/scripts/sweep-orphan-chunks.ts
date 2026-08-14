#!/usr/bin/env bun
/**
 * sweep-orphan-chunks.ts — Preventative orphan-chunk cleanup
 *
 * Scrolls each Qdrant collection and removes points whose source_path
 * no longer exists on disk. Guards against stale vectors accumulating
 * after directory moves, renames, or retired namespace removals.
 *
 * Usage:
 *   bun packages/selfheal/scripts/sweep-orphan-chunks.ts
 *   bun packages/selfheal/scripts/sweep-orphan-chunks.ts commerce-a-knowledge shared-memory-facts
 *   bun packages/selfheal/scripts/sweep-orphan-chunks.ts --dry-run
 *   bun packages/selfheal/scripts/sweep-orphan-chunks.ts --json
 *
 * Exit codes:
 *   0 — clean or dry-run complete
 *   1 — one or more collections errored
 */

import { existsSync } from 'fs';
import { Database } from 'bun:sqlite';
import { getMemoryDbPath } from 'zouroboros-core';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://127.0.0.1:6333';
const DEFAULT_COLLECTIONS = [
  'zouroboros-research',
  'zouroboros-code',
  'shared-memory-facts',
  'commerce-a-knowledge',
  'code-docs',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const jsonMode = args.includes('--json');
const collectionArgs = args.filter(a => !a.startsWith('--'));
const collections = collectionArgs.length > 0 ? collectionArgs : DEFAULT_COLLECTIONS;

interface SweepResult {
  collection: string;
  total_scanned: number;
  orphans_found: number;
  deleted: number;
  error?: string;
}

async function scrollCollection(
  collection: string,
  offset?: string,
): Promise<{ points: any[]; next_page_offset: string | null }> {
  const body: Record<string, unknown> = { limit: 250, with_payload: true, with_vector: false };
  if (offset) body.offset = offset;

  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`scroll failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    points: data.result?.points ?? [],
    next_page_offset: data.result?.next_page_offset ?? null,
  };
}

async function deletePoints(collection: string, ids: (string | number)[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: ids }),
  });
  if (!res.ok) throw new Error(`delete failed: HTTP ${res.status}`);
}

function resolveSourcePath(payload: Record<string, unknown>): string | null {
  const candidate = payload?.source_path ?? payload?.path ?? payload?.file_path;
  if (!candidate || typeof candidate !== 'string') return null;
  // Only verify absolute paths — relative ones cannot be resolved without context
  if (!candidate.startsWith('/')) return null;
  return candidate;
}

function isOrphan(payload: Record<string, unknown>): boolean {
  const p = resolveSourcePath(payload);
  if (!p) return false;
  return !existsSync(p);
}

async function sweepCollection(collection: string): Promise<SweepResult> {
  const result: SweepResult = { collection, total_scanned: 0, orphans_found: 0, deleted: 0 };

  try {
    let offset: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const { points, next_page_offset } = await scrollCollection(collection, offset);
      result.total_scanned += points.length;

      const orphanIds: (string | number)[] = points
        .filter(p => isOrphan(p.payload ?? {}))
        .map(p => p.id);

      result.orphans_found += orphanIds.length;

      if (!dryRun && orphanIds.length > 0) {
        await deletePoints(collection, orphanIds);
        result.deleted += orphanIds.length;
      }

      if (next_page_offset && points.length > 0) {
        offset = next_page_offset;
      } else {
        hasMore = false;
      }
    }
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

function persistResults(results: SweepResult[]): void {
  try {
    const db = new Database(getMemoryDbPath());
    db.run(`
      CREATE TABLE IF NOT EXISTS rag_orphan_sweeps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        collection   TEXT    NOT NULL,
        total_scanned INTEGER NOT NULL,
        orphans_found INTEGER NOT NULL,
        deleted       INTEGER NOT NULL,
        dry_run       INTEGER NOT NULL DEFAULT 0,
        error         TEXT
      )
    `);

    const insert = db.prepare(`
      INSERT INTO rag_orphan_sweeps
        (collection, total_scanned, orphans_found, deleted, dry_run, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of results) {
      insert.run(r.collection, r.total_scanned, r.orphans_found, r.deleted, dryRun ? 1 : 0, r.error ?? null);
    }
    db.close();
  } catch {
    // Non-fatal — sweep results already printed to stdout
  }
}

const results: SweepResult[] = [];

for (const col of collections) {
  const r = await sweepCollection(col);
  results.push(r);

  if (!jsonMode) {
    const status = r.error
      ? '❌'
      : r.orphans_found === 0
      ? '✅'
      : dryRun
      ? '🔍'
      : '🧹';
    const detail = r.error
      ? `error: ${r.error}`
      : `scanned=${r.total_scanned} orphans=${r.orphans_found}${
          !dryRun && r.orphans_found > 0 ? ` deleted=${r.deleted}` : ''
        }${dryRun && r.orphans_found > 0 ? ' (dry-run, not deleted)' : ''}`;
    console.log(`${status} ${col}: ${detail}`);
  }
}

persistResults(results);

if (jsonMode) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const totalOrphans = results.reduce((sum, r) => sum + r.orphans_found, 0);
  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
  const label = dryRun ? 'found (dry-run)' : 'deleted';
  console.log(`\nTotal orphan chunks ${label}: ${dryRun ? totalOrphans : totalDeleted}`);
}

if (results.some(r => r.error)) process.exit(1);
