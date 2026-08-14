/**
 * approve.ts — verified approval / rejection of a pending candidate.
 *
 * One-shot enforcement: the DB transaction reads `approval_status` and
 * transitions it within the same statement; concurrent CLI invocations from
 * the same email link will see one win and the other reject.
 *
 * Token verification uses hmac.verifyToken (timingSafeEqual + 14d expiry).
 *
 * On approval, the candidate directory is moved Skills/_candidates/<slug>/
 * → Skills/<slug>/ via promote.promote.  All file moves happen INSIDE the DB
 * transaction so a partial failure leaves the row in 'pending' for retry.
 */

import type { Database } from 'bun:sqlite';
import { verifyToken } from './hmac.js';
import { promote, archiveCandidate } from './promote.js';
import type { EventType } from './types.js';
import { recordPromotionHealth } from './candidate-handoff.js';

export interface ApproveInputs {
  db: Database;
  skills_root: string;
  id: string;
  token: string;
  /** Override now for tests. */
  nowSeconds?: number;
  /** Automated promotion is fail-closed unless deterministic replay passed. */
  automated?: boolean;
}

export type DecideOutcome =
  | { ok: true; action: 'approved'; promoted_path: string; token_prefix_8: string }
  | { ok: true; action: 'rejected'; archive_path: string; token_prefix_8: string }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_resolved'
        | 'token_invalid'
        | 'token_expired'
        | 'token_missing_secret'
        | 'token_malformed'
        | 'replay_required'
        | 'promotion_failed';
      detail?: string;
      token_prefix_8: string;
    };

interface CrystRow {
  id: string;
  slug: string;
  draft_path: string;
  created_at: number;
  approval_status: 'pending' | 'approved' | 'rejected' | 'expired';
  eval_status: string;
}

function load(db: Database, id: string): CrystRow | undefined {
  return db
    .prepare(
      `SELECT id, slug, draft_path, created_at, approval_status, eval_status
         FROM crystallizations
        WHERE id = ?`,
    )
    .get(id) as CrystRow | undefined;
}

function appendEvent(
  db: Database,
  crystallization_id: string,
  event_type: EventType,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO crystallization_events (crystallization_id, event_type, payload)
     VALUES (?, ?, ?)`,
  ).run(crystallization_id, event_type, JSON.stringify(payload));
}

export function approveCandidate(i: ApproveInputs): DecideOutcome {
  const now = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  const row = load(i.db, i.id);
  if (!row) {
    return {
      ok: false,
      reason: 'not_found',
      token_prefix_8: i.token.slice(0, 8),
    };
  }
  if (row.approval_status !== 'pending') {
    return {
      ok: false,
      reason: 'already_resolved',
      detail: row.approval_status,
      token_prefix_8: i.token.slice(0, 8),
    };
  }
  if (i.automated && row.eval_status !== 'replay_pass') {
    appendEvent(i.db, row.id, 'rejected', {
      ok: false,
      reason: 'replay_required',
      eval_status: row.eval_status,
      automated: true,
    });
    return {
      ok: false,
      reason: 'replay_required',
      detail: `automated promotion requires replay_pass; found ${row.eval_status}`,
      token_prefix_8: i.token.slice(0, 8),
    };
  }

  const v = verifyToken(
    { id: row.id, created_at: row.created_at, candidate_path: row.draft_path },
    i.token,
    now,
  );
  if (!v.ok) {
    appendEvent(i.db, row.id, 'rejected', {
      ok: false,
      reason: v.reason,
      token_prefix_8: v.token_prefix_8,
    });
    const reasonMap: Record<string, DecideOutcome['ok'] extends false ? string : never> = {} as never;
    void reasonMap;
    return {
      ok: false,
      reason:
        v.reason === 'expired'
          ? 'token_expired'
          : v.reason === 'malformed'
          ? 'token_malformed'
          : v.reason === 'missing-secret'
          ? 'token_missing_secret'
          : 'token_invalid',
      token_prefix_8: v.token_prefix_8,
    };
  }

  let promoted_path: string;
  try {
    const result = promote({
      candidate_path: row.draft_path,
      skills_root: i.skills_root,
      slug: row.slug,
    });
    promoted_path = result.promoted_path;
  } catch (err) {
    return {
      ok: false,
      reason: 'promotion_failed',
      detail: err instanceof Error ? err.message : String(err),
      token_prefix_8: v.token_prefix_8,
    };
  }

  i.db.transaction(() => {
    i.db.prepare(
      `UPDATE crystallizations
          SET approval_status = 'approved',
              promoted_path = ?,
              approved_at = ?
        WHERE id = ? AND approval_status = 'pending'`,
    ).run(promoted_path, now, row.id);
    const promotionHealth = recordPromotionHealth({
      db: i.db,
      crystallization_id: row.id,
      slug: row.slug,
      promoted_path,
      nowSeconds: now,
    });
    appendEvent(i.db, row.id, 'approved', { token_prefix_8: v.token_prefix_8 });
    appendEvent(i.db, row.id, 'promoted', {
      promoted_path,
      observation: 'reuse_survivability',
      ...promotionHealth,
    });
  })();

  return {
    ok: true,
    action: 'approved',
    promoted_path,
    token_prefix_8: v.token_prefix_8,
  };
}

export function rejectCandidate(i: ApproveInputs): DecideOutcome {
  const now = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  const row = load(i.db, i.id);
  if (!row) {
    return {
      ok: false,
      reason: 'not_found',
      token_prefix_8: i.token.slice(0, 8),
    };
  }
  if (row.approval_status !== 'pending') {
    return {
      ok: false,
      reason: 'already_resolved',
      detail: row.approval_status,
      token_prefix_8: i.token.slice(0, 8),
    };
  }

  const v = verifyToken(
    { id: row.id, created_at: row.created_at, candidate_path: row.draft_path },
    i.token,
    now,
  );
  if (!v.ok) {
    appendEvent(i.db, row.id, 'rejected', {
      ok: false,
      reason: v.reason,
      token_prefix_8: v.token_prefix_8,
    });
    return {
      ok: false,
      reason:
        v.reason === 'expired'
          ? 'token_expired'
          : v.reason === 'malformed'
          ? 'token_malformed'
          : v.reason === 'missing-secret'
          ? 'token_missing_secret'
          : 'token_invalid',
      token_prefix_8: v.token_prefix_8,
    };
  }

  const archive = archiveCandidate({
    candidate_path: row.draft_path,
    skills_root: i.skills_root,
    slug: row.slug,
    id: row.id,
  });

  i.db.transaction(() => {
    i.db.prepare(
      `UPDATE crystallizations
          SET approval_status = 'rejected',
              approved_at = ?
        WHERE id = ? AND approval_status = 'pending'`,
    ).run(now, row.id);
    appendEvent(i.db, row.id, 'rejected', {
      ok: true,
      archive_path: archive.archive_path,
      token_prefix_8: v.token_prefix_8,
    });
  })();

  return {
    ok: true,
    action: 'rejected',
    archive_path: archive.archive_path,
    token_prefix_8: v.token_prefix_8,
  };
}
