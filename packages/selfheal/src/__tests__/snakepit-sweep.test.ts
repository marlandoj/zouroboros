import { describe, test, expect } from 'bun:test';
import { computeDelta, runSweep, type SweepRecord } from '../snakepit/sweep.js';
import type { SnakePitReport, FixtureVerdict, ArchetypeRollup } from '../snakepit/inject.js';
import { ARCHETYPE_IDS, type ArchetypeId } from '../snakepit/taxonomy.js';

function verdict(id: string, archetype: ArchetypeId, status: FixtureVerdict['status'], baited = false): FixtureVerdict {
  return {
    id,
    archetype,
    severity: 'high',
    status,
    detectionOk: status !== 'fail',
    expectOk: status !== 'fail',
    rejectOk: !baited,
    bait: baited ? ['took-bait'] : [],
    matched: [],
    reason: status,
  };
}

function report(verdicts: FixtureVerdict[]): SnakePitReport {
  const byArchetype = Object.fromEntries(
    ARCHETYPE_IDS.map((id) => [id, { applicable: 0, passed: 0, failed: 0, skipped: 0 } as ArchetypeRollup])
  ) as Record<ArchetypeId, ArchetypeRollup>;
  let applicable = 0,
    passed = 0,
    failed = 0,
    skipped = 0;
  const baited: string[] = [];
  for (const v of verdicts) {
    const roll = byArchetype[v.archetype];
    if (v.status === 'skip') {
      skipped++;
      roll.skipped++;
      continue;
    }
    applicable++;
    roll.applicable++;
    if (v.status === 'pass') {
      passed++;
      roll.passed++;
    } else {
      failed++;
      roll.failed++;
    }
    if (v.bait.length) baited.push(v.id);
  }
  return {
    total: verdicts.length,
    applicable,
    passed,
    failed,
    skipped,
    passRate: applicable === 0 ? 0 : passed / applicable,
    baited,
    byArchetype,
    verdicts,
  };
}

function asPrevious(r: SnakePitReport): SweepRecord {
  return { sweepId: 'prev-1234', timestamp: '2026-06-01T00:00:00.000Z', report: r };
}

describe('computeDelta', () => {
  test('no previous sweep → no regression, zero delta', () => {
    const cur = report([verdict('a', 'goodhart', 'pass')]);
    const d = computeDelta(cur, null);
    expect(d.regression).toBe(false);
    expect(d.passRateDelta).toBe(0);
    expect(d.previousSweepId).toBeNull();
  });

  test('pass rate drop is a regression', () => {
    const prev = asPrevious(report([verdict('a', 'goodhart', 'pass'), verdict('b', 'goodhart', 'pass')]));
    const cur = report([verdict('a', 'goodhart', 'pass'), verdict('b', 'goodhart', 'fail')]);
    const d = computeDelta(cur, prev);
    expect(d.passRateDelta).toBeCloseTo(-0.5, 6);
    expect(d.regression).toBe(true);
    expect(d.newlyFailed).toEqual(['b']);
    expect(d.regressedArchetypes).toContain('goodhart');
  });

  test('a newly baited fixture is a regression even if pass rate is unchanged', () => {
    // Same pass/fail counts, but fixture "c" now takes bait (still counted as fail in both).
    const prev = asPrevious(report([verdict('c', 'blind-spot', 'fail', false)]));
    const cur = report([verdict('c', 'blind-spot', 'fail', true)]);
    const d = computeDelta(cur, prev);
    expect(d.passRateDelta).toBe(0);
    expect(d.newlyBaited).toEqual(['c']);
    expect(d.regression).toBe(true);
  });

  test('improvement (more passing) is not a regression', () => {
    const prev = asPrevious(report([verdict('a', 'goodhart', 'fail')]));
    const cur = report([verdict('a', 'goodhart', 'pass')]);
    const d = computeDelta(cur, prev);
    expect(d.passRateDelta).toBeCloseTo(1, 6);
    expect(d.regression).toBe(false);
    expect(d.newlyFailed).toEqual([]);
    expect(d.regressedArchetypes).toEqual([]);
  });
});

describe('runSweep — fail-safe', () => {
  test('unmeasurable report → null (no phantom regression)', () => {
    expect(runSweep({ produceReport: () => null, persist: false })).toBeNull();
  });

  test('injected report with persist:false returns a record without writing', () => {
    const r = report([verdict('a', 'goodhart', 'pass')]);
    const result = runSweep({ produceReport: () => r, persist: false });
    expect(result).not.toBeNull();
    expect(result!.persistedPath).toBeNull();
    expect(result!.record.report.passRate).toBe(1);
  });

  test('shared replay corpus result is attached to the sweep', () => {
    const r = report([verdict('a', 'goodhart', 'pass')]);
    const result = runSweep({
      produceReport: () => r,
      produceReplay: () => ({ total: 2, passed: 1, failed: 1, errors: 0 }),
      persist: false,
    });
    expect(result!.replay).toEqual({ total: 2, passed: 1, failed: 1, errors: 0 });
    expect(result!.replay.failed).toBe(1);
  });
});
