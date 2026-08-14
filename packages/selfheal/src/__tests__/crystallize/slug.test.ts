/**
 * Fixture-driven tests for slug validation + collision resolution.
 * Covers FX-08, FX-09, FX-10.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { normalizeSourceSlug, resolveSlugCollision, validateSlug } from '../../crystallize/slug.js';

const FIX = join(import.meta.dir, '..', 'fixtures', 'crystallize');

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

describe('crystallize/slug (FX-08,09,10)', () => {
  test('FX-08 path-traversal & malformed slugs rejected (reason=regex)', () => {
    const fx = loadFixture('FX-08-slug-traversal.json');
    for (const candidate of fx.input.rejectingInputs) {
      const result = validateSlug(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(fx.expected.expectedReason);
      }
    }
  });

  test('FX-09 too-short / too-long bounds enforced', () => {
    const fx = loadFixture('FX-09-slug-too-short.json');
    for (const candidate of fx.input.rejectingInputs) {
      const r = validateSlug(candidate);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('too_short');
    }
    const tooLong = validateSlug(fx.input.tooLongInput);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toBe(fx.expected.tooLongReason);
  });

  describe('FX-10 collision resolves via -2/-3 suffix', () => {
    let tmp: string;
    let candidatesRoot: string;
    let promotedRoot: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'crystallize-fx10-'));
      candidatesRoot = join(tmp, 'candidates');
      promotedRoot = join(tmp, 'promoted');
      mkdirSync(candidatesRoot, { recursive: true });
      mkdirSync(promotedRoot, { recursive: true });
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test('first collision → -2', () => {
      const fx = loadFixture('FX-10-slug-collision.json');
      mkdirSync(join(candidatesRoot, fx.input.preexistingDirs[0]));
      const resolved = resolveSlugCollision(fx.input.baseSlug, {
        candidatesRoot,
        promotedRoot,
      });
      expect(resolved).toBe(fx.expected.resolvedSlug);
    });

    test('second collision → -3', () => {
      const fx = loadFixture('FX-10-slug-collision.json');
      for (const d of fx.secondCollisionInput.preexistingDirs) {
        mkdirSync(join(candidatesRoot, d));
      }
      const resolved = resolveSlugCollision(fx.secondCollisionInput.baseSlug, {
        candidatesRoot,
        promotedRoot,
      });
      expect(resolved).toBe(fx.secondCollisionExpected.resolvedSlug);
    });

    test('no collision returns base slug unchanged', () => {
      const resolved = resolveSlugCollision('fresh-slug', {
        candidatesRoot,
        promotedRoot,
      });
      expect(resolved).toBe('fresh-slug');
    });
  });

  test('valid slugs accepted', () => {
    for (const good of ['foo', 'foo-bar', 'foo-bar-baz', 'a1b', 'deploy-zo-route']) {
      const r = validateSlug(good);
      expect(r.ok).toBe(true);
    }
  });

  test('source-derived names are normalized and bounded before evaluation', () => {
    const normalized = normalizeSourceSlug('Swarm swarm_1785076357645-remediation:-2');
    expect(normalized).toBe('swarm-swarm-1785076357645-remediation-2');
    expect(validateSlug(normalized).ok).toBe(true);
    expect(normalizeSourceSlug('x'.repeat(100))).toHaveLength(48);
    expect(validateSlug(normalizeSourceSlug('x'.repeat(100))).ok).toBe(true);
  });

  test('collision suffix remains within the maximum slug length', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'crystallize-long-slug-'));
    const candidatesRoot = join(tmp, 'candidates');
    const promotedRoot = join(tmp, 'promoted');
    mkdirSync(candidatesRoot, { recursive: true });
    mkdirSync(promotedRoot, { recursive: true });
    const base = 'a'.repeat(48);
    mkdirSync(join(candidatesRoot, base));
    const resolved = resolveSlugCollision(base, { candidatesRoot, promotedRoot });
    expect(resolved).toBe(`${'a'.repeat(46)}-2`);
    expect(validateSlug(resolved).ok).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
