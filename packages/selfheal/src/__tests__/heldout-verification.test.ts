/**
 * ZOU-882 B1 — single-sourced held-out post-flight verification.
 * Proves the extracted pure logic matches the previously-inline behavior:
 * regression detection, hidden divergence / Goodhart drift, and the success
 * derivation that a textual run marker alone can never satisfy.
 */

import { test, expect } from 'bun:test';
import {
  detectRegression,
  resolveDivergence,
  deriveVerifiedSuccess,
  verifyHeldout,
  type ScorecardLike,
} from '../evolve/heldout-verification.js';

const sc = (metrics: Array<[string, number, number]>): ScorecardLike => ({
  composite: 0,
  metrics: metrics.map(([name, value, score]) => ({ name, value, score, status: 'OK' })),
});

// --- detectRegression ----------------------------------------------------

test('no regression when scores hold or improve', () => {
  const base = sc([['Memory Recall', 1, 0.80]]);
  const post = sc([['Memory Recall', 1, 0.82]]);
  expect(detectRegression(base, post).regression).toBe(false);
});

test('regression when a score drops beyond the threshold', () => {
  const base = sc([['Memory Recall', 1, 0.80]]);
  const post = sc([['Memory Recall', 1, 0.70]]); // -0.10 < -0.02
  const r = detectRegression(base, post);
  expect(r.regression).toBe(true);
  expect(r.drops[0].name).toBe('Memory Recall');
  expect(r.drops[0].delta).toBeCloseTo(-0.1, 6);
});

test('small dips within threshold are not regressions', () => {
  const base = sc([['Memory Recall', 1, 0.80]]);
  const post = sc([['Memory Recall', 1, 0.79]]); // -0.01, within -0.02
  expect(detectRegression(base, post).regression).toBe(false);
});

test('unmeasurable metrics (negative value) are skipped', () => {
  const base = sc([['X', -1, 0.9]]);
  const post = sc([['X', 1, 0.1]]);
  expect(detectRegression(base, post).regression).toBe(false);
});

test('null scorecards yield no regression', () => {
  expect(detectRegression(null, sc([['A', 1, 1]])).regression).toBe(false);
  expect(detectRegression(sc([['A', 1, 1]]), null).regression).toBe(false);
});

// --- resolveDivergence ---------------------------------------------------

test('divergence is null (tripwire off) when the hidden bank is unmeasurable', () => {
  const s = sc([['Memory Recall', 1, 0.8]]);
  expect(
    resolveDivergence({ hiddenBaseline: null, baseline: s, post: s, scoreHiddenAfter: () => 0.8 }),
  ).toBeNull();
});

test('scoreHiddenAfter is NOT sampled when the guard fails (cost parity)', () => {
  let calls = 0;
  const after = () => { calls++; return 0.8; };
  resolveDivergence({ hiddenBaseline: null, baseline: sc([]), post: sc([]), scoreHiddenAfter: after });
  expect(calls).toBe(0);
});

test('Goodhart flag when visible rose but hidden did not', () => {
  const base = sc([['Memory Recall', 1, 0.70]]);
  const post = sc([['Memory Recall', 1, 0.85]]); // visibleDelta +0.15
  const rep = resolveDivergence({
    hiddenBaseline: 0.70,
    baseline: base,
    post,
    scoreHiddenAfter: () => 0.70, // hiddenDelta 0 -> divergence 0.15 > 0.05
  });
  expect(rep?.goodhartFlag).toBe(true);
});

test('no Goodhart flag when visible and hidden move together', () => {
  const base = sc([['Memory Recall', 1, 0.70]]);
  const post = sc([['Memory Recall', 1, 0.76]]); // visibleDelta +0.06
  const rep = resolveDivergence({
    hiddenBaseline: 0.70,
    baseline: base,
    post,
    scoreHiddenAfter: () => 0.75, // hiddenDelta +0.05 -> divergence 0.01 <= 0.05
  });
  expect(rep?.goodhartFlag).toBe(false);
});

test('divergence null when the visible metric is absent', () => {
  const base = sc([['Other', 1, 0.7]]);
  const post = sc([['Other', 1, 0.9]]);
  expect(
    resolveDivergence({ hiddenBaseline: 0.7, baseline: base, post, scoreHiddenAfter: () => 0.7 }),
  ).toBeNull();
});

// --- deriveVerifiedSuccess ----------------------------------------------

test('verified success requires exec success AND no regression AND no drift', () => {
  expect(deriveVerifiedSuccess({ execSuccess: true, regression: false, goodhartFlag: false })).toBe(true);
  expect(deriveVerifiedSuccess({ execSuccess: false, regression: false, goodhartFlag: false })).toBe(false);
  expect(deriveVerifiedSuccess({ execSuccess: true, regression: true, goodhartFlag: false })).toBe(false);
  expect(deriveVerifiedSuccess({ execSuccess: true, regression: false, goodhartFlag: true })).toBe(false);
});

// --- verifyHeldout composition ------------------------------------------

test('Goodhart drift forces failure even when execution succeeded with no regression', () => {
  const base = sc([['Memory Recall', 1, 0.70]]);
  const post = sc([['Memory Recall', 1, 0.90]]); // visible +0.20
  const v = verifyHeldout({
    execSuccess: true,
    hiddenBaseline: 0.70,
    baseline: base,
    post,
    scoreHiddenAfter: () => 0.70, // hidden flat -> drift
  });
  expect(v.goodhartFlag).toBe(true);
  expect(v.verifiedSuccess).toBe(false);
});

test('clean improvement mirrored by the hidden bank verifies as success', () => {
  const base = sc([['Memory Recall', 1, 0.70]]);
  const post = sc([['Memory Recall', 1, 0.76]]);
  const v = verifyHeldout({
    execSuccess: true,
    hiddenBaseline: 0.70,
    baseline: base,
    post,
    scoreHiddenAfter: () => 0.75,
  });
  expect(v.regression).toBe(false);
  expect(v.goodhartFlag).toBe(false);
  expect(v.verifiedSuccess).toBe(true);
});
