import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkSnapshot, loadBaseline, writeBaseline } from '../snakepit/snapshot.js';
import type { SweepRecord } from '../snakepit/sweep.js';
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

function baselineOf(r: SnakePitReport): SweepRecord {
  return { sweepId: 'baseline-0001', timestamp: '2026-06-01T00:00:00.000Z', report: r };
}

describe('checkSnapshot — guardrail semantics', () => {
  test('unmeasurable current report → null (fail-safe, no phantom regression)', () => {
    expect(checkSnapshot({ produceReport: () => null, baseline: baselineOf(report([])) })).toBeNull();
  });

  test('no committed baseline → non-blocking no-baseline (ok=true, null delta)', () => {
    const cur = report([verdict('a', 'goodhart', 'pass')]);
    const g = checkSnapshot({ produceReport: () => cur, baseline: null })!;
    expect(g.status).toBe('no-baseline');
    expect(g.ok).toBe(true);
    expect(g.delta).toBeNull();
    expect(g.baselineSweepId).toBeNull();
  });

  test('current matches baseline (same partial-pass floor) → ok', () => {
    const base = baselineOf(report([verdict('a', 'goodhart', 'pass'), verdict('b', 'blind-spot', 'fail')]));
    const cur = report([verdict('a', 'goodhart', 'pass'), verdict('b', 'blind-spot', 'fail')]);
    const g = checkSnapshot({ produceReport: () => cur, baseline: base })!;
    expect(g.status).toBe('ok');
    expect(g.ok).toBe(true);
    expect(g.delta!.regression).toBe(false);
    expect(g.baselineSweepId).toBe('baseline-0001');
  });

  test('a fixture that passed in baseline now failing → regression (ok=false)', () => {
    const base = baselineOf(report([verdict('a', 'goodhart', 'pass'), verdict('b', 'goodhart', 'pass')]));
    const cur = report([verdict('a', 'goodhart', 'pass'), verdict('b', 'goodhart', 'fail')]);
    const g = checkSnapshot({ produceReport: () => cur, baseline: base })!;
    expect(g.status).toBe('regression');
    expect(g.ok).toBe(false);
    expect(g.delta!.newlyFailed).toEqual(['b']);
    expect(g.delta!.regressedArchetypes).toContain('goodhart');
  });

  test('a fixture newly taking bait → regression even when pass rate is unchanged', () => {
    const base = baselineOf(report([verdict('c', 'blind-spot', 'fail', false)]));
    const cur = report([verdict('c', 'blind-spot', 'fail', true)]);
    const g = checkSnapshot({ produceReport: () => cur, baseline: base })!;
    expect(g.delta!.passRateDelta).toBe(0);
    expect(g.status).toBe('regression');
    expect(g.delta!.newlyBaited).toEqual(['c']);
  });

  test('improvement above the ratified floor is not a regression', () => {
    const base = baselineOf(report([verdict('a', 'goodhart', 'fail')]));
    const cur = report([verdict('a', 'goodhart', 'pass')]);
    const g = checkSnapshot({ produceReport: () => cur, baseline: base })!;
    expect(g.status).toBe('ok');
    expect(g.ok).toBe(true);
    expect(g.delta!.passRateDelta).toBeCloseTo(1, 6);
  });
});

describe('writeBaseline / loadBaseline — committed ratchet round-trip', () => {
  test('writeBaseline then loadBaseline returns the same record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snakepit-baseline-'));
    const path = join(dir, 'baseline-snapshot.json');
    const record = baselineOf(report([verdict('a', 'goodhart', 'pass'), verdict('b', 'blind-spot', 'fail')]));
    const written = writeBaseline(record, path);
    expect(written).toBe(path);
    const loaded = loadBaseline(path)!;
    expect(loaded.sweepId).toBe(record.sweepId);
    expect(loaded.report.passRate).toBeCloseTo(0.5, 6);
    // checkSnapshot reads the just-written baseline from disk (no injected record).
    const cur = report([verdict('a', 'goodhart', 'pass'), verdict('b', 'blind-spot', 'fail')]);
    const g = checkSnapshot({ produceReport: () => cur, baselinePath: path })!;
    expect(g.status).toBe('ok');
  });

  test('loadBaseline on a missing path → null', () => {
    expect(loadBaseline(join(tmpdir(), 'does-not-exist-snakepit-baseline.json'))).toBeNull();
  });

  test('loadBaseline on unparseable JSON → null (fail-safe)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snakepit-baseline-bad-'));
    const path = join(dir, 'baseline-snapshot.json');
    writeFileSync(path, '{ not valid json');
    expect(loadBaseline(path)).toBeNull();
    // sanity: the file really is there and unparseable
    expect(() => JSON.parse(readFileSync(path, 'utf-8'))).toThrow();
  });
});
