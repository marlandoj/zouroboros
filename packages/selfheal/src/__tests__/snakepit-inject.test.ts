import { describe, test, expect } from 'bun:test';
import { evaluateFixture, runSnakePit, type FixtureProbe, type ProbeResult } from '../snakepit/inject.js';
import { SNAKE_PIT_FIXTURES, type AdversarialFixture } from '../snakepit/taxonomy.js';

function fixture(over: Partial<AdversarialFixture> = {}): AdversarialFixture {
  return {
    id: 'f',
    archetype: 'goodhart',
    query: 'q',
    attack: 'a',
    ...over,
  };
}

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  applicable: true,
  lines: [],
  needsMemory: true,
  ...over,
});

describe('evaluateFixture — reject (took-the-bait) check', () => {
  test('surfacing a rejectAny marker fails the fixture and records the bait', () => {
    const v = evaluateFixture(
      fixture({ rejectAny: ['we adopted', 'rolled out a2a'], expectAny: ['skipped'] }),
      probe({ lines: ['decision = we adopted a2a last week'] })
    );
    expect(v.status).toBe('fail');
    expect(v.rejectOk).toBe(false);
    expect(v.bait).toEqual(['we adopted']);
  });

  test('no bait marker present → rejectOk true', () => {
    const v = evaluateFixture(
      fixture({ rejectAny: ['we adopted'], expectAny: ['skipped'] }),
      probe({ lines: ['decision = a2a adoption was skipped'] })
    );
    expect(v.rejectOk).toBe(true);
    expect(v.status).toBe('pass');
    expect(v.matched).toEqual(['skipped']);
  });
});

describe('evaluateFixture — detection check', () => {
  test('detection waived when expectDetection is undefined', () => {
    const v = evaluateFixture(fixture({ expectAny: ['x'] }), probe({ needsMemory: false, lines: ['x'] }));
    expect(v.detectionOk).toBe(true);
  });

  test('detection mismatch fails when expectDetection is pinned', () => {
    const v = evaluateFixture(
      fixture({ expectDetection: true, expectAny: ['x'] }),
      probe({ needsMemory: false, lines: ['x'] })
    );
    expect(v.detectionOk).toBe(false);
    expect(v.status).toBe('fail');
  });

  test('nonexistent incident searches memory and passes on empty retrieval', () => {
    const nonexistent = SNAKE_PIT_FIXTURES.find((item) => item.id === 'snake-blindspot-nonexistent');
    expect(nonexistent).toBeDefined();

    const v = evaluateFixture(nonexistent!, probe({ needsMemory: true, lines: [] }));
    expect(v.status).toBe('pass');
    expect(v.detectionOk).toBe(true);
    expect(v.expectOk).toBe(true);
    expect(v.rejectOk).toBe(true);
  });
});

describe('evaluateFixture — expect check', () => {
  test('expectAny waived for a no-detection (expectDetection=false) case', () => {
    const v = evaluateFixture(
      fixture({ archetype: 'blind-spot', expectDetection: false, expectAny: ['no record'] }),
      probe({ needsMemory: false, lines: [] })
    );
    expect(v.expectOk).toBe(true);
    expect(v.status).toBe('pass');
  });

  test('missing every expectAny needle fails', () => {
    const v = evaluateFixture(fixture({ expectAny: ['columnar', 'backfill'] }), probe({ lines: ['unrelated line'] }));
    expect(v.expectOk).toBe(false);
    expect(v.status).toBe('fail');
  });
});

describe('evaluateFixture — applicability', () => {
  test('non-applicable probe yields skip with all checks neutral', () => {
    const v = evaluateFixture(fixture({ rejectAny: ['x'] }), probe({ applicable: false }));
    expect(v.status).toBe('skip');
    expect(v.detectionOk && v.expectOk && v.rejectOk).toBe(true);
  });
});

describe('runSnakePit — aggregation', () => {
  test('passRate is over applicable fixtures only; skips excluded', () => {
    const fixtures: AdversarialFixture[] = [
      fixture({ id: 'a', expectAny: ['x'] }),
      fixture({ id: 'b', archetype: 'collapse', expectAny: ['y'] }),
      fixture({ id: 'c', archetype: 'blind-spot', rejectAny: ['bait'] }),
    ];
    const p: FixtureProbe = (f) => {
      if (f.id === 'a') return probe({ lines: ['x'] }); // pass
      if (f.id === 'b') return probe({ applicable: false }); // skip
      return probe({ lines: ['contains bait here'] }); // fail (bait)
    };
    const report = runSnakePit(p, fixtures);
    expect(report.total).toBe(3);
    expect(report.applicable).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBeCloseTo(0.5, 6);
    expect(report.baited).toEqual(['c']);
    expect(report.byArchetype.collapse.skipped).toBe(1);
    expect(report.byArchetype['blind-spot'].failed).toBe(1);
  });

  test('runs over the real SNAKE_PIT_FIXTURES with an all-skip probe → 0 applicable, no crash', () => {
    const report = runSnakePit(() => ({ applicable: false, lines: [], needsMemory: false }), SNAKE_PIT_FIXTURES);
    expect(report.total).toBe(SNAKE_PIT_FIXTURES.length);
    expect(report.applicable).toBe(0);
    expect(report.skipped).toBe(SNAKE_PIT_FIXTURES.length);
    expect(report.passRate).toBe(0);
  });
});
