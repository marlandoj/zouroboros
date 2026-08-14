/**
 * expire.ts — gc job for pending candidates that crossed expires_at.
 *
 * Per seed AC: "Token expires at created_at + 14 days; CLI rejects expired
 * tokens; nightly gc job sets approval_status='expired' and archives candidate."
 *
 * On every invocation:
 *   1. SELECT * FROM crystallizations WHERE approval_status='pending' AND
 *      expires_at <= now.
 *   2. For each row:
 *      a. UPDATE approval_status='expired'
 *      b. INSERT INTO crystallization_events ('expired', payload={age_days})
 *      c. Move draft directory to Skills/_candidates/_expired/<slug>-<id8>/
 *         (via promote.archiveCandidate)
 *
 * Idempotent — re-running the gc is a no-op for already-expired rows.
 */

import type { Database } from 'bun:sqlite';
import { archiveCandidate } from './promote.js';

export interface ExpireOptions {
  db: Database;
  skills_root: string;
  /** Override now for tests. */
  nowSeconds?: number;
}

export interface ExpireResult {
  expired_ids: string[];
  archived_count: number;
}

interface PendingRow {
  id: string;
  slug: string;
  draft_path: string;
  created_at: number;
  expires_at: number;
}

export function expirePending(opts: ExpireOptions): ExpireResult {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  const rows = opts.db
    .prepare(
      `SELECT id, slug, draft_path, created_at, expires_at
         FROM crystallizations
        WHERE approval_status = 'pending'
          AND expires_at <= ?`,
    )
    .all(now) as PendingRow[];

  if (rows.length === 0) {
    return { expired_ids: [], archived_count: 0 };
  }

  const updateStmt = opts.db.prepare(
    `UPDATE crystallizations
        SET approval_status = 'expired'
      WHERE id = ?`,
  );
  const eventStmt = opts.db.prepare(
    `INSERT INTO crystallization_events (crystallization_id, event_type, payload)
     VALUES (?, 'expired', ?)`,
  );

  const expired_ids: string[] = [];
  let archived_count = 0;

  const tx = opts.db.transaction((batch: PendingRow[]) => {
    for (const r of batch) {
      updateStmt.run(r.id);
      const ageDays = Math.floor((now - r.created_at) / 86_400);
      eventStmt.run(r.id, JSON.stringify({ age_days: ageDays }));
      expired_ids.push(r.id);
    }
  });
  tx(rows);

  for (const r of rows) {
    try {
      archiveCandidate({
        candidate_path: r.draft_path,
        skills_root: opts.skills_root,
        slug: r.slug,
        id: r.id,
      });
      archived_count++;
    } catch {
      // Filesystem failures don't roll back the DB transition — the row is
      // expired and an operator can clean up the orphan via RB-2 runbook.
    }
  }

  return { expired_ids, archived_count };
}
