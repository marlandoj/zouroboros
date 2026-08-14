import { describe, test, expect } from 'bun:test';
import {
  classifyDrift,
  cosineDistance,
  meanVector,
  DEFAULT_THRESHOLDS,
} from '../../scripts/monitor-rag-drift.js';

describe('cosineDistance', () => {
  test('identical vectors → 0', () => {
    expect(cosineDistance([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 6);
  });
  test('orthogonal vectors → 1', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 6);
  });
  test('zero vector → 1 (max distance)', () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
  });
});

describe('meanVector', () => {
  test('returns null for empty input', () => {
    expect(meanVector([])).toBeNull();
  });
  test('averages component-wise', () => {
    const m = meanVector([[1, 2], [3, 4]]);
    expect(m).toEqual([2, 3]);
  });
  test('skips mismatched dimension vectors', () => {
    const m = meanVector([[1, 2], [3, 4], [5]]);
    // The third vector has length 1; pure averaging would taint dim 0.
    // The implementation skips mismatched lengths.
    expect(m).toEqual([(1 + 3 + 0) / 3, (2 + 4 + 0) / 3]);
    // Note: meanVector divides by total count (3) not skipped count.
    // Documenting current behaviour.
  });
});

describe('classifyDrift', () => {
  test('first run → BASELINE_CAPTURED', () => {
    const r = classifyDrift(null, null, 1000);
    expect(r.status).toBe('BASELINE_CAPTURED');
  });

  test('low drift, small size delta → OK', () => {
    const r = classifyDrift(0.01, 1000, 1050);
    expect(r.status).toBe('OK');
  });

  test('moderate drift → DRIFTING', () => {
    const r = classifyDrift(0.08, 1000, 1000);
    expect(r.status).toBe('DRIFTING');
    expect(r.reason).toContain('embedding_dist=0.0800');
  });

  test('large size delta → DRIFTING', () => {
    const r = classifyDrift(0.01, 1000, 1300); // 30% growth
    expect(r.status).toBe('DRIFTING');
  });

  test('breach drift → BREACH', () => {
    const r = classifyDrift(0.20, 1000, 1000);
    expect(r.status).toBe('BREACH');
  });

  test('breach size delta → BREACH', () => {
    const r = classifyDrift(0.01, 1000, 1600); // 60% growth
    expect(r.status).toBe('BREACH');
  });

  test('custom thresholds tighten classification', () => {
    const tight = { ...DEFAULT_THRESHOLDS, driftWarn: 0.005, driftBreach: 0.01 };
    const r = classifyDrift(0.02, 1000, 1000, tight);
    expect(r.status).toBe('BREACH');
  });
});
