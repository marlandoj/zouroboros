#!/usr/bin/env bun
/**
 * Standalone held-out bank replenishment job (ZOU-279).
 *
 * Mines RECENT REAL open loops from the live memory DB and hands them to
 * replenishHoldoutBank() (introspect/holdout.ts), which synthesizes minted cases,
 * enforces disjointness from the visible continuation eval set, and rotates them
 * into the LOCAL bank (~/.zouroboros/holdout-fixtures.local.json). Minted content
 * never enters git — only the synthetic seed is committed.
 *
 * This MUST stay decoupled from introspect/evolve: the examiner-refresh is run on its
 * own schedule (e.g. a weekly agent), never from the optimization loop, so the loop
 * can never influence its own hidden examiner. The Holdout Freshness tripwire (weight
 * 0) surfaces if the schedule stops running.
 *
 * Lives under standalone/ (tsc-excluded) because it imports bun:sqlite. Output (stdout):
 *   REPLENISH_ADDED <n>       cases minted this pass
 *   REPLENISH_REJECTED <n>    candidates dropped for disjointness/quality
 *   REPLENISH_TOTAL <n>       cases now in the rotating local bank
 *   REPLENISH_DISJOINT <1|0>  local bank verified disjoint from the visible set
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { replenishHoldoutBank, type ReplenishCandidate } from '../introspect/holdout.ts';

const WINDOW_DAYS = 14;
const MINE_LIMIT = 40;

function memoryDbPath(): string {
  return (
    process.env.ZOUROBOROS_MEMORY_DB ||
    process.env.ZO_MEMORY_DB ||
    join(homedir(), '.zouroboros', 'memory.db')
  );
}

function mineCandidates(dbPath: string): ReplenishCandidate[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const since = nowSec - WINDOW_DAYS * 86400;
    const rows = db
      .prepare(
        `SELECT title, summary, kind, status, priority, entity, created_at, updated_at
         FROM open_loops
         WHERE status IN ('open','stale') AND updated_at >= ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(since, MINE_LIMIT) as Array<Record<string, unknown>>;

    return rows
      .filter((r) => String(r.title ?? '').trim().length > 0)
      .map((r) => ({
        title: String(r.title),
        summary: String(r.summary ?? r.title),
        kind: String(r.kind ?? 'task'),
        status: String(r.status ?? 'open'),
        priority: typeof r.priority === 'number' ? r.priority : 0.6,
        entity: (r.entity as string | null) ?? null,
        createdDaysAgo: Math.max(0, Math.round((nowSec - Number(r.created_at ?? nowSec)) / 86400)),
        updatedDaysAgo: Math.max(0, Math.round((nowSec - Number(r.updated_at ?? nowSec)) / 86400)),
      }));
  } finally {
    db.close();
  }
}

function main() {
  const dbPath = memoryDbPath();
  if (!existsSync(dbPath)) {
    // Fail-safe quiet: no DB → nothing to mine. Freshness tripwire stays seed-only.
    console.log('REPLENISH_ADDED 0');
    console.log('REPLENISH_REJECTED 0');
    console.log('REPLENISH_TOTAL 0');
    console.log('REPLENISH_DISJOINT 1');
    return;
  }

  const candidates = mineCandidates(dbPath);
  const report = replenishHoldoutBank({ candidates });

  console.log(`REPLENISH_ADDED ${report.added}`);
  console.log(`REPLENISH_REJECTED ${report.rejectedDisjoint}`);
  console.log(`REPLENISH_TOTAL ${report.total}`);
  console.log(`REPLENISH_DISJOINT ${report.disjoint ? 1 : 0}`);
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
