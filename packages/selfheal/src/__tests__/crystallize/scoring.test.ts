/**
 * Fixture-driven tests for weightSources.
 * Covers FX-01, FX-03, FX-04, FX-29.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { weightSources } from '../../crystallize/score.js';
import type { ScoreInputs } from '../../crystallize/score.js';

const FIX = join(import.meta.dir, '..', 'fixtures', 'crystallize');

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

describe('crystallize/score (FX-01,03,04,29)', () => {
  test('FX-01 happy-path-procedure produces exactly one candidate ≥3.0', () => {
    const fx = loadFixture('FX-01-happy-path-procedure.json');
    const out = weightSources(fx.input as ScoreInputs);
    expect(out).toHaveLength(fx.expected.candidateCount);
    expect(out[0]!.score).toBeGreaterThanOrEqual(3.0);
    expect(out[0]!.source_kind).toBe(fx.expected.topCandidate.source_kind);
    expect(out[0]!.slug_suggestion).toBe(fx.expected.topCandidate.slug_suggestion);
    const sourceIds = out[0]!.sources.map((s) => s.id).sort();
    expect(sourceIds).toEqual(fx.expected.topCandidate.sourceIds.sort());
    // Signature is deterministic per sorted source IDs.
    expect(out[0]!.source_signature).toMatch(/^[0-9a-f]{64}$/);
  });

  test('FX-03 below-threshold produces zero candidates', () => {
    const fx = loadFixture('FX-03-below-threshold.json');
    const out = weightSources(fx.input as ScoreInputs);
    expect(out).toHaveLength(fx.expected.candidateCount);
  });

  test('FX-04 cold-start window admits 2.0 cluster', () => {
    const fx = loadFixture('FX-04-cold-start-window.json');
    const out = weightSources(fx.input as ScoreInputs);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const top = out.find((c) => c.slug_suggestion === fx.expected.topCandidate.slug_suggestion);
    expect(top).toBeDefined();
    expect(top!.score).toBeGreaterThanOrEqual(2.0);
    expect(top!.source_kind).toBe('procedure');
  });

  test('FX-29 mixed-source-kind: at least one cluster crosses threshold', () => {
    const fx = loadFixture('FX-29-mixed-source-kind.json');
    const out = weightSources(fx.input as ScoreInputs);
    expect(out.length).toBeGreaterThanOrEqual(fx.expected.candidateCountMin);
    const totalScore = out.reduce((s, c) => s + c.score, 0);
    expect(totalScore).toBeGreaterThanOrEqual(fx.expected.totalScoreMin);
  });
});
