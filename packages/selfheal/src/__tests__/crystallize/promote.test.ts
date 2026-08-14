/**
 * promote / archiveCandidate coverage.
 *
 * Asserts:
 *   • promote() moves Skills/_candidates/<slug>/ → Skills/<slug>/ and returns
 *     the absolute promoted_path; source removed; destination present
 *   • path drift (different parent) ⇒ PromotionUnsafePathError
 *   • destination already present ⇒ DestinationExistsError (no overwrite)
 *   • candidate missing ⇒ CandidateMissingError
 *   • archiveCandidate is idempotent (second call after the first succeeds
 *     without overwriting)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  promote,
  archiveCandidate,
  CandidateMissingError,
  DestinationExistsError,
  PromotionUnsafePathError,
} from '../../crystallize/promote.js';

let tmp = '';
let skillsRoot = '';

function seed(slug: string, fileName = 'SKILL.md', content = '# x'): string {
  const dir = join(skillsRoot, '_candidates', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content);
  return dir;
}

describe('crystallize/promote', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cryst-promote-'));
    skillsRoot = join(tmp, 'Skills');
    mkdirSync(skillsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('happy path moves directory and returns absolute promoted_path', () => {
    const candidate_path = seed('deploy-route');
    const r = promote({
      candidate_path,
      skills_root: skillsRoot,
      slug: 'deploy-route',
    });
    expect(r.promoted_path).toBe(join(skillsRoot, 'deploy-route'));
    expect(existsSync(candidate_path)).toBe(false);
    expect(existsSync(join(skillsRoot, 'deploy-route', 'SKILL.md'))).toBe(true);
  });

  test('candidate_path drift ⇒ PromotionUnsafePathError', () => {
    seed('legit');
    expect(() =>
      promote({
        candidate_path: join(tmp, 'elsewhere', 'legit'),
        skills_root: skillsRoot,
        slug: 'legit',
      }),
    ).toThrow(PromotionUnsafePathError);
  });

  test('destination collision ⇒ DestinationExistsError', () => {
    const candidate_path = seed('collide');
    mkdirSync(join(skillsRoot, 'collide'));
    expect(() =>
      promote({
        candidate_path,
        skills_root: skillsRoot,
        slug: 'collide',
      }),
    ).toThrow(DestinationExistsError);
  });

  test('missing candidate ⇒ CandidateMissingError', () => {
    expect(() =>
      promote({
        candidate_path: join(skillsRoot, '_candidates', 'absent'),
        skills_root: skillsRoot,
        slug: 'absent',
      }),
    ).toThrow(CandidateMissingError);
  });

  test('relative skills_root ⇒ PromotionUnsafePathError', () => {
    seed('rel');
    expect(() =>
      promote({
        candidate_path: join(skillsRoot, '_candidates', 'rel'),
        skills_root: 'Skills',
        slug: 'rel',
      }),
    ).toThrow(PromotionUnsafePathError);
  });

  test('archiveCandidate places under _candidates/_expired/<slug>-<id8>', () => {
    const candidate_path = seed('rejected');
    const r = archiveCandidate({
      candidate_path,
      skills_root: skillsRoot,
      slug: 'rejected',
      id: '12345678-aaaa-bbbb-cccc-deadbeefcafe',
    });
    expect(r.archive_path).toBe(
      join(skillsRoot, '_candidates', '_expired', 'rejected-12345678'),
    );
    expect(existsSync(r.archive_path)).toBe(true);
  });

  test('archiveCandidate is idempotent (no-op if archive exists)', () => {
    const candidate_path = seed('idem');
    archiveCandidate({
      candidate_path,
      skills_root: skillsRoot,
      slug: 'idem',
      id: '11111111-2222-3333-4444-555555555555',
    });
    // Recreate the source dir; second call should silently consume it.
    const candidate_path2 = seed('idem');
    const r2 = archiveCandidate({
      candidate_path: candidate_path2,
      skills_root: skillsRoot,
      slug: 'idem',
      id: '11111111-2222-3333-4444-555555555555',
    });
    expect(r2.archive_path).toBe(
      join(skillsRoot, '_candidates', '_expired', 'idem-11111111'),
    );
    expect(existsSync(candidate_path2)).toBe(false);
  });
});
