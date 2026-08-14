/**
 * approveCandidate / rejectCandidate — FX-17, FX-27.
 *
 * Asserts:
 *   • happy path approves, promotes files, sets approval_status, appends events
 *   • second approve on the same row returns ok=false reason=already_resolved
 *     (FX-17 — replay defense)
 *   • happy path rejects, archives draft, appends rejected event
 *   • token mismatch ⇒ ok=false reason=token_invalid; row stays pending
 *   • token expired ⇒ ok=false reason=token_expired; row stays pending
 *   • not_found ⇒ ok=false reason=not_found
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
import { approveCandidate, rejectCandidate } from '../../crystallize/approve.js';
import { signToken } from '../../crystallize/hmac.js';
import { APPROVAL_TTL_DAYS } from '../../crystallize/types.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

const ENV_KEY = 'CRYSTALLIZE_APPROVAL_SECRET';
let tmp = '';
let skillsRoot = '';
let db: Database;
let savedSecret: string | undefined;

function seedRow(
  id: string,
  slug: string,
  draft_path: string,
  created_at: number,
  eval_status = 'mechanical_pass',
): void {
  db.prepare(
    `INSERT INTO crystallizations
       (id, slug, source_kind, source_ids, source_signature, weighted_score,
        draft_path, trigger_kind, llm_cost_usd, created_at, expires_at,
        eval_status, approval_status)
     VALUES (?, ?, 'procedure', '[]', ?, 3.0, ?, 'manual', 0, ?, ?, ?, 'pending')`,
  ).run(
    id,
    slug,
    `sig-${id}`,
    draft_path,
    created_at,
    created_at + APPROVAL_TTL_DAYS * 86_400,
    eval_status,
  );
}

function seedDraft(slug: string): string {
  const dir = join(skillsRoot, '_candidates', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: t\n---\n\n# ${slug}\n`,
  );
  return dir;
}

describe('crystallize/approve (FX-17, FX-27)', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cryst-approve-'));
    skillsRoot = join(tmp, 'Skills');
    mkdirSync(skillsRoot, { recursive: true });
    db = freshCrystallizationsDb();
    savedSecret = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'a'.repeat(32);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    if (savedSecret === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedSecret;
  });

  test('FX-27: approve promotes draft and updates row + events', () => {
    const fx = FX('FX-27-approve-promotes-files');
    const id = fx.input.id;
    const slug = fx.input.slug;
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at);
    db.prepare(
      `INSERT INTO crystallization_events
         (crystallization_id, event_type, payload)
       VALUES (?, 'created', '{}')`,
    ).run(id);

    const tok = signToken({ id, created_at, candidate_path: draft });
    const r = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token: tok,
      nowSeconds: created_at + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe('approved');
    expect(r.promoted_path).toBe(join(skillsRoot, slug));
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(join(skillsRoot, slug, 'SKILL.md'))).toBe(true);

    const row = db
      .prepare(`SELECT approval_status, promoted_path FROM crystallizations WHERE id = ?`)
      .get(id) as { approval_status: string; promoted_path: string };
    expect(row.approval_status).toBe(fx.expected.approval_status);
    expect(row.promoted_path).toBe(join(skillsRoot, slug));

    const events = db
      .prepare(
        `SELECT event_type FROM crystallization_events
          WHERE crystallization_id = ?
          ORDER BY id ASC`,
      )
      .all(id) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toEqual(fx.expected.events);
  });

  test('FX-17: re-approve on already-approved row ⇒ already_resolved', () => {
    const fx = FX('FX-17-hmac-replay-after-approve');
    const id = fx.input.id;
    const slug = fx.input.slug;
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at);

    const tok = signToken({ id, created_at, candidate_path: draft });
    const first = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token: tok,
      nowSeconds: created_at + 1,
    });
    expect(first.ok).toBe(true);

    const second = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token: tok,
      nowSeconds: created_at + 2,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe(fx.expected.second_call.reason);
    expect(second.detail).toBe(fx.expected.second_call.detail);
  });

  test('reject archives draft and updates row + appends rejected event', () => {
    const id = '00000000-0000-0000-0000-000000000099';
    const slug = 'reject-me';
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at);

    const tok = signToken({ id, created_at, candidate_path: draft });
    const r = rejectCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token: tok,
      nowSeconds: created_at + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe('rejected');
    expect(existsSync(draft)).toBe(false);
    expect(
      existsSync(join(skillsRoot, '_candidates', '_expired', `${slug}-${id.slice(0, 8)}`)),
    ).toBe(true);

    const row = db
      .prepare(`SELECT approval_status FROM crystallizations WHERE id = ?`)
      .get(id) as { approval_status: string };
    expect(row.approval_status).toBe('rejected');
  });

  test('tampered token ⇒ token_invalid, row stays pending', () => {
    const id = '00000000-0000-0000-0000-000000000044';
    const slug = 'tampered';
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at);

    const tok = signToken({ id, created_at, candidate_path: draft });
    const tampered = tok.slice(0, -1) + (tok.slice(-1) === '0' ? '1' : '0');
    const r = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token: tampered,
      nowSeconds: created_at + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('token_invalid');

    const row = db
      .prepare(`SELECT approval_status FROM crystallizations WHERE id = ?`)
      .get(id) as { approval_status: string };
    expect(row.approval_status).toBe('pending');
  });

  test('expired token ⇒ token_expired, draft NOT promoted', () => {
    const id = '00000000-0000-0000-0000-000000000055';
    const slug = 'aged';
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at);

    const tok = signToken({ id, created_at, candidate_path: draft });
    const r = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token: tok,
      nowSeconds: created_at + APPROVAL_TTL_DAYS * 86_400 + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('token_expired');
    expect(existsSync(draft)).toBe(true);
  });

  test('not_found id ⇒ ok=false reason=not_found', () => {
    const r = approveCandidate({
      db,
      skills_root: skillsRoot,
      id: 'no-such-id',
      token: 'deadbeefcafebabe1122334455667788990011223344556677889900aabbccdd',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
  });

  test('automated promotion is blocked without replay_pass', () => {
    const id = '00000000-0000-0000-0000-000000000066';
    const slug = 'automation-blocked';
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at, 'mechanical_only');
    const token = signToken({ id, created_at, candidate_path: draft });

    const result = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token,
      automated: true,
      nowSeconds: created_at + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('replay_required');
    expect(existsSync(draft)).toBe(true);
  });

  test('automated promotion accepts replay_pass evidence', () => {
    const id = '00000000-0000-0000-0000-000000000077';
    const slug = 'automation-replayed';
    const created_at = 1700000000;
    const draft = seedDraft(slug);
    seedRow(id, slug, draft, created_at, 'replay_pass');
    const token = signToken({ id, created_at, candidate_path: draft });

    const result = approveCandidate({
      db,
      skills_root: skillsRoot,
      id,
      token,
      automated: true,
      nowSeconds: created_at + 1,
    });
    expect(result.ok).toBe(true);
  });
});
