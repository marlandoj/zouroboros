import { describe, test, expect } from 'bun:test';
import { cosine, scoreFromPoints } from '../../scripts/score-chunk-quality.js';

function vec(...n: number[]): number[] { return n; }

describe('cosine', () => {
  test('identical vectors → 1', () => {
    expect(cosine(vec(1, 0, 0), vec(1, 0, 0))).toBeCloseTo(1, 6);
  });
  test('orthogonal vectors → 0', () => {
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
  });
  test('mismatched length → 0', () => {
    expect(cosine(vec(1, 2), vec(1, 2, 3))).toBe(0);
  });
  test('zero vector → 0', () => {
    expect(cosine(vec(0, 0), vec(1, 1))).toBe(0);
  });
});

describe('scoreFromPoints', () => {
  test('two-doc collection — DCC and ICC reflect proximity', () => {
    // Doc A: tightly packed (high DCC + ICC)
    // Doc B: dispersed (lower DCC, lower ICC)
    const points = [
      // Doc A
      { id: 'a1', payload: { source_path: '/A.pdf', chunk_index: 0, content: 'a1' }, vector: [1, 0, 0] },
      { id: 'a2', payload: { source_path: '/A.pdf', chunk_index: 1, content: 'a2' }, vector: [0.99, 0.01, 0] },
      { id: 'a3', payload: { source_path: '/A.pdf', chunk_index: 2, content: 'a3' }, vector: [0.98, 0.02, 0] },
      // Doc B
      { id: 'b1', payload: { source_path: '/B.pdf', chunk_index: 0, content: 'b1' }, vector: [1, 0, 0] },
      { id: 'b2', payload: { source_path: '/B.pdf', chunk_index: 1, content: 'b2' }, vector: [0, 1, 0] },
      { id: 'b3', payload: { source_path: '/B.pdf', chunk_index: 2, content: 'b3' }, vector: [0, 0, 1] },
    ];

    const q = scoreFromPoints('test-coll', points);
    expect(q.collection).toBe('test-coll');
    expect(q.docsExamined).toBe(2);
    expect(q.sampleSize).toBe(6);
    expect(q.meanDCC).not.toBeNull();
    expect(q.meanICC).not.toBeNull();

    // Sanity checks: DCC is bounded ∈ [0, 1] and ICC similarly.
    // Doc A pairwise mean ≈ 0.999, Doc B pairwise mean ≈ 0.
    // So overall meanDCC should sit between (≈ 0.5).
    expect(q.meanDCC! >= 0).toBe(true);
    expect(q.meanDCC! <= 1).toBe(true);
    expect(q.meanICC! >= 0).toBe(true);
    expect(q.meanICC! <= 1).toBe(true);

    expect(q.perDocRows.length).toBe(2);
    for (const r of q.perDocRows) {
      expect(r.icc).not.toBeNull();
      expect(r.dcc).not.toBeNull();
    }
  });

  test('single-chunk docs are skipped (no pairs)', () => {
    const points = [
      { id: 'a', payload: { source_path: '/A.pdf' }, vector: [1, 0] },
      { id: 'b', payload: { source_path: '/B.pdf' }, vector: [0, 1] },
    ];
    const q = scoreFromPoints('c', points);
    expect(q.docsExamined).toBe(2);
    expect(q.perDocRows.length).toBe(0);
    expect(q.meanDCC).toBeNull();
    expect(q.meanICC).toBeNull();
  });

  test('handles missing vectors gracefully', () => {
    const points = [
      { id: 'a1', payload: { source_path: '/A' }, vector: [1, 0] },
      { id: 'a2', payload: { source_path: '/A' } }, // no vector
      { id: 'a3', payload: { source_path: '/A' }, vector: [0.9, 0.1] },
    ];
    const q = scoreFromPoints('c', points);
    expect(q.docsExamined).toBe(1);
    // Doc has 3 chunks but only 2 have vectors → should still produce ICC/DCC
    expect(q.perDocRows.length).toBe(1);
  });

  test('high DCC for tightly clustered doc', () => {
    const points = [
      { id: '1', payload: { source_path: '/X.pdf', chunk_index: 0 }, vector: [1, 0, 0, 0] },
      { id: '2', payload: { source_path: '/X.pdf', chunk_index: 1 }, vector: [0.95, 0.05, 0, 0] },
      { id: '3', payload: { source_path: '/X.pdf', chunk_index: 2 }, vector: [0.9, 0.1, 0, 0] },
    ];
    const q = scoreFromPoints('c', points);
    expect(q.meanDCC).not.toBeNull();
    expect(q.meanDCC!).toBeGreaterThan(0.9);
    expect(q.meanICC!).toBeGreaterThan(0.9);
  });

  test('low DCC for dispersed doc', () => {
    const points = [
      { id: '1', payload: { source_path: '/X.pdf', chunk_index: 0 }, vector: [1, 0, 0, 0] },
      { id: '2', payload: { source_path: '/X.pdf', chunk_index: 1 }, vector: [0, 1, 0, 0] },
      { id: '3', payload: { source_path: '/X.pdf', chunk_index: 2 }, vector: [0, 0, 1, 0] },
      { id: '4', payload: { source_path: '/X.pdf', chunk_index: 3 }, vector: [0, 0, 0, 1] },
    ];
    const q = scoreFromPoints('c', points);
    expect(q.meanDCC).not.toBeNull();
    expect(q.meanDCC!).toBeLessThan(0.1);
    expect(q.meanICC!).toBeLessThan(0.1);
  });
});
