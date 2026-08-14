/**
 * capacity — FX-22.
 *
 * Counts only `pending` rows whose eval_status is not a hard fail. Returns ok
 * iff pending < ceiling.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import { freshCrystallizationsDb } from './_helpers.js';
import { checkCapacity } from '../../crystallize/capacity.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

function seedRow(
  db: Database,
  i: number,
  approval_status: string,
  eval_status: string,
): void {
  db.prepare(
    `INSERT INTO crystallizations
       (id, slug, source_kind, source_ids, source_signature, weighted_score,
        draft_path, trigger_kind, llm_cost_usd, created_at, expires_at,
        eval_status, approval_status)
     VALUES (?, ?, 'procedure', '[]', ?, 3.0, ?, 'manual', 0, ?, ?, ?, ?)`,
  ).run(
    `id-${i}`,
    `slug-${i}`,
    `sig-${i}`,
    `/tmp/Skills/_candidates/slug-${i}`,
    1700000000,
    1700000000 + 14 * 86_400,
    eval_status,
    approval_status,
  );
}

describe('crystallize/capacity (FX-22)', () => {
  test('FX-22: 5 pending hits the ceiling and blocks new draft', () => {
    const fx = FX('FX-22-capacity-ceiling-pending');
    const db = freshCrystallizationsDb();

    for (let i = 0; i < fx.input.pending_count; i++) {
      seedRow(db, i, 'pending', 'pending');
    }
    const r = checkCapacity(db, fx.input.ceiling);
    expect(r.ok).toBe(false);
    expect(r.pending_count).toBe(fx.expected.checkCapacity.pending_count);
    expect(r.ceiling).toBe(fx.expected.checkCapacity.ceiling);
  });

  test('mechanical_fail rows are NOT counted toward the ceiling', () => {
    const db = freshCrystallizationsDb();

    seedRow(db, 1, 'pending', 'pending');
    seedRow(db, 2, 'pending', 'pending');
    // Three failed rows that sit as pending should not block new drafts.
    seedRow(db, 3, 'pending', 'mechanical_fail');
    seedRow(db, 4, 'pending', 'mechanical_fail');
    seedRow(db, 5, 'pending', 'replay_fail');

    const r = checkCapacity(db, 5);
    expect(r.pending_count).toBe(2);
    expect(r.ok).toBe(true);
  });

  test('approved rows do not count', () => {
    const db = freshCrystallizationsDb();
    seedRow(db, 1, 'approved', 'mechanical_pass');
    seedRow(db, 2, 'rejected', 'mechanical_fail');
    const r = checkCapacity(db, 5);
    expect(r.pending_count).toBe(0);
    expect(r.ok).toBe(true);
  });
});
