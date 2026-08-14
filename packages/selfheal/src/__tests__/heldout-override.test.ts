/**
 * ZOU-882 B2 — held-out override + shared scorecard capture.
 *
 * Covers the promotion-authority semantics executeEvolution gains: success is
 * governed by the shared held-out verification (regression + Goodhart), and
 * fail-closed when the introspect scorecard is unmeasurable. The executor's own
 * wiring is a thin pass-through around these two pure/injectable units; the
 * flag-off byte-identical guarantee is structural (the whole block sits behind
 * `if (heldoutOn)` in executor.ts).
 */

import { describe, it, expect } from 'bun:test';
import type { ScorecardLike } from '../evolve/heldout-verification.js';
import { deriveHeldoutOverride } from '../evolve/heldout-verification.js';
import { getScorecard, type ScorecardRunResult } from '../evolve/scorecard.js';

const RECALL = 'Memory Recall';

function card(recallScore: number, extra?: Array<[string, number]>): ScorecardLike {
  const metrics = [{ name: RECALL, value: recallScore, score: recallScore, status: 'HEALTHY' }];
  for (const [name, score] of extra ?? []) {
    metrics.push({ name, value: score, score, status: 'HEALTHY' });
  }
  return { composite: recallScore, metrics };
}

describe('deriveHeldoutOverride — held-out verdict, fail-closed', () => {
  it('certifies a clean measured run (no regression, no drift)', () => {
    const o = deriveHeldoutOverride({
      execSuccess: true,
      reverted: false,
      detail: 'ran',
      hiddenBaseline: 0.8,
      baseline: card(0.8),
      post: card(0.83),
      scoreHiddenAfter: () => 0.83, // hidden moved with visible ⇒ no Goodhart
    });
    expect(o.measurable).toBe(true);
    expect(o.success).toBe(true);
    expect(o.reverted).toBe(false);
    expect(o.detail).toContain('[heldout] verified=true');
  });

  it('FAIL-CLOSED when the baseline scorecard is unmeasurable (null)', () => {
    const o = deriveHeldoutOverride({
      execSuccess: true,
      reverted: false,
      detail: 'ran',
      hiddenBaseline: 0.8,
      baseline: null,
      post: card(0.83),
      scoreHiddenAfter: () => 0.83,
    });
    expect(o.measurable).toBe(false);
    expect(o.success).toBe(false);
    expect(o.reverted).toBe(true);
    expect(o.detail).toContain('fail-closed');
  });

  it('FAIL-CLOSED when the post scorecard is unmeasurable (null)', () => {
    const o = deriveHeldoutOverride({
      execSuccess: true,
      reverted: false,
      detail: 'ran',
      hiddenBaseline: 0.8,
      baseline: card(0.8),
      post: null,
      scoreHiddenAfter: () => 0.83,
    });
    expect(o.measurable).toBe(false);
    expect(o.success).toBe(false);
  });

  it('forces failure on a scorecard regression even when execution succeeded', () => {
    const o = deriveHeldoutOverride({
      execSuccess: true,
      reverted: false,
      detail: 'ran',
      hiddenBaseline: 0.8,
      baseline: card(0.8, [['Wiring Health', 0.9]]),
      post: card(0.82, [['Wiring Health', 0.8]]), // -0.10 drop > 0.02 threshold ⇒ regression
      scoreHiddenAfter: () => 0.82,
    });
    expect(o.verification.regression).toBe(true);
    expect(o.success).toBe(false);
    expect(o.reverted).toBe(true);
  });

  it('forces failure on Goodhart drift — visible gain the hidden bank did not mirror', () => {
    const o = deriveHeldoutOverride({
      execSuccess: true,
      reverted: false,
      detail: 'ran',
      hiddenBaseline: 0.7,
      baseline: card(0.7),
      post: card(0.85), // visible +0.15
      scoreHiddenAfter: () => 0.7, // hidden flat ⇒ divergence 0.15 > 0.05 tolerance
    });
    expect(o.verification.goodhartFlag).toBe(true);
    expect(o.success).toBe(false);
  });

  it('never certifies when the raw execution itself failed', () => {
    const o = deriveHeldoutOverride({
      execSuccess: false,
      reverted: true,
      detail: 'exited nonzero',
      hiddenBaseline: 0.8,
      baseline: card(0.8),
      post: card(0.83),
      scoreHiddenAfter: () => 0.83,
    });
    expect(o.success).toBe(false);
    expect(o.reverted).toBe(true);
  });

  it('never un-reverts a result the mode already reverted, even on a clean verdict', () => {
    const o = deriveHeldoutOverride({
      execSuccess: true,
      reverted: true, // mode reverted
      detail: 'reverted by mode',
      hiddenBaseline: 0.8,
      baseline: card(0.8),
      post: card(0.83),
      scoreHiddenAfter: () => 0.83,
    });
    expect(o.success).toBe(true); // verification itself passed
    expect(o.reverted).toBe(true); // but the reverted flag is sticky
  });
});

describe('getScorecard — shared introspect capture (injected runner)', () => {
  const ok = (stdout: string): ScorecardRunResult => ({ stdout, ok: true, code: 0 });
  const fail = (): ScorecardRunResult => ({ stdout: '', ok: false, code: 1 });

  it('parses a valid introspect JSON payload', () => {
    const payload = JSON.stringify({
      composite: 0.81,
      metrics: [{ name: RECALL, value: 0.81, score: 0.81, status: 'HEALTHY' }],
    });
    const sc = getScorecard('/x/introspect.ts', () => ok(payload));
    expect(sc).not.toBeNull();
    expect(sc!.composite).toBe(0.81);
    expect(sc!.metrics[0]!.name).toBe(RECALL);
  });

  it('returns null when the introspect CLI fails', () => {
    expect(getScorecard('/x/introspect.ts', () => fail())).toBeNull();
  });

  it('returns null on empty stdout', () => {
    expect(getScorecard('/x/introspect.ts', () => ok(''))).toBeNull();
  });

  it('returns null on unparseable JSON', () => {
    expect(getScorecard('/x/introspect.ts', () => ok('not json'))).toBeNull();
  });
});
