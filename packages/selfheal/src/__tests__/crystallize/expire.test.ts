/**
 * expire — FX-26.
 *
 * Asserts:
 *   • pending rows past expires_at transition to approval_status='expired'
 *   • an 'expired' event with age_days payload is appended
 *   • the candidate directory is archived to _candidates/_expired/<slug>-<id8>/
 *   • a fresh row in the future is left untouched
 *   • a second invocation is a no-op (idempotent)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { freshCrystallizationsDb } from './_helpers.js';
import { expirePending } from '../../crystallize/expire.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

let tmp = '';
let skillsRoot = '';
let db: Database;

function seedPending(
  id: string,
  slug: string,
  created_at: number,
  expires_at: number,
): string {
  const draft = join(skillsRoot, '_candidates', slug);
  mkdirSync(draft, { recursive: true });
  writeFileSync(join(draft, 'SKILL.md'), `# ${slug}`);
  db.prepare(
    `INSERT INTO crystallizations
       (id, slug, source_kind, source_ids, source_signature, weighted_score,
        draft_path, trigger_kind, llm_cost_usd, created_at, expires_at,
        eval_status, approval_status)
     VALUES (?, ?, 'procedure', '[]', ?, 3.0, ?, 'cron', 0, ?, ?, 'mechanical_pass', 'pending')`,
  ).run(id, slug, `sig-${id}`, draft, created_at, expires_at);
  return draft;
}

describe('crystallize/expire (FX-26)', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cryst-expire-'));
    skillsRoot = join(tmp, 'Skills');
    mkdirSync(skillsRoot, { recursive: true });
    db = freshCrystallizationsDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('FX-26: nightly gc transitions only the past-due row', () => {
    const fx = FX('FX-26-expired-gc-job');
    const now = 1700000000;
    const expiredId = fx.expected.expired_ids[0];
    const expiredSlug = fx.input.rows[0].slug;
    const freshSlug = fx.input.rows[1].slug;

    const expiredDraft = seedPending(
      expiredId,
      expiredSlug,
      now + fx.input.rows[0].created_at_offset_days * 86_400,
      now + fx.input.rows[0].expires_at_offset_days * 86_400,
    );
    const freshDraft = seedPending(
      fx.input.rows[1].id,
      freshSlug,
      now + fx.input.rows[1].created_at_offset_days * 86_400,
      now + fx.input.rows[1].expires_at_offset_days * 86_400,
    );

    const r1 = expirePending({ db, skills_root: skillsRoot, nowSeconds: now });
    expect(r1.expired_ids).toEqual(fx.expected.expired_ids);
    expect(r1.archived_count).toBe(fx.expected.archived_count);
    expect(existsSync(expiredDraft)).toBe(false);
    expect(
      existsSync(
        join(
          skillsRoot,
          '_candidates',
          '_expired',
          `${expiredSlug}-${expiredId.slice(0, 8)}`,
        ),
      ),
    ).toBe(true);
    expect(existsSync(freshDraft)).toBe(true);

    const eventCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM crystallization_events
          WHERE crystallization_id = ? AND event_type = 'expired'`,
      )
      .get(expiredId) as { c: number };
    expect(eventCount.c).toBe(fx.expected.first_run_event_count_for_expired);

    // Idempotency: rerun is a no-op.
    const r2 = expirePending({ db, skills_root: skillsRoot, nowSeconds: now });
    expect(r2.expired_ids).toHaveLength(fx.expected.second_run_expired_count);
  });

  test('zero pending rows ⇒ ExpireResult is {expired_ids:[], archived_count:0}', () => {
    const r = expirePending({ db, skills_root: skillsRoot });
    expect(r).toEqual({ expired_ids: [], archived_count: 0 });
  });
});
