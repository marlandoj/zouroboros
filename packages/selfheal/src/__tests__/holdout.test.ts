import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isoWeekKey,
  selectHeldout,
  loadHoldoutFixtures,
  loadMergedFixtures,
  hiddenComposite,
  scoreHiddenComposite,
  buildDivergenceReport,
  DIVERGENCE_TOLERANCE,
  buildVisibleVocabulary,
  synthesizeHoldoutCases,
  verifyDisjoint,
  mergeReplenished,
  replenishHoldoutBank,
  bankFreshness,
  localReplenishBankPath,
  loadLocalReplenishedBank,
  REPLENISH_MAX_CASES,
  parseHoldoutSubchecks,
  type HiddenCaseResult,
  type ReplenishCandidate,
  type ReplenishedEntry,
  type HoldoutFixtureSet,
  type HoldoutSubcheck,
} from '../introspect/holdout';

const VISIBLE_FIXTURE_PATH = join(
  process.env.ZO_WORKSPACE || '/home/workspace',
  'Skills/zo-memory-system/assets/continuation-eval-fixture-set.json'
);

describe('holdout — anti-Goodhart held-out eval bank (E1)', () => {
  describe('isoWeekKey', () => {
    test('produces a stable YYYY-Www key', () => {
      const key = isoWeekKey(new Date(Date.UTC(2026, 5, 1))); // 2026-06-01
      expect(key).toMatch(/^\d{4}-W\d{2}$/);
    });
  });

  describe('AC-E1.1 — rotating partition differs across epochs', () => {
    test('held-out set differs for at least two epoch keys', () => {
      const a = selectHeldout('2026-W10');
      const b = selectHeldout('2026-W11');
      expect(a.heldoutCaseIds).not.toEqual(b.heldoutCaseIds);
      // both are non-empty subsets of the bank
      const all = loadHoldoutFixtures().cases.map((c) => c.id);
      for (const id of a.heldoutCaseIds) expect(all).toContain(id);
      for (const id of b.heldoutCaseIds) expect(all).toContain(id);
      expect(a.heldoutCaseIds.length).toBeGreaterThan(0);
    });

    test('selection is deterministic for a given epoch', () => {
      expect(selectHeldout('2026-W22').heldoutCaseIds).toEqual(
        selectHeldout('2026-W22').heldoutCaseIds
      );
    });
  });

  describe('AC-E1.2 — disjoint from the visible set, same scoring math', () => {
    test('held-out case ids are disjoint from the visible continuation set', () => {
      const holdout = loadHoldoutFixtures().cases.map((c) => c.id);
      // Structural guarantee, enforced everywhere (including CI, where the external
      // visible fixture is not vendored into the repo): every held-out id lives in the
      // reserved `holdout-` namespace that the visible continuation set never uses, so
      // disjointness holds by construction and cannot drift.
      for (const id of holdout) expect(id.startsWith('holdout-')).toBe(true);

      // Empirical cross-check when the external visible fixture is reachable (local Zo
      // workspace). Skipped where the file is absent by design (CI runner).
      if (existsSync(VISIBLE_FIXTURE_PATH)) {
        const visible = (JSON.parse(readFileSync(VISIBLE_FIXTURE_PATH, 'utf-8')).cases as Array<{ id: string }>).map(
          (c) => c.id
        );
        const overlap = holdout.filter((id) => visible.includes(id));
        expect(overlap).toEqual([]);
      }
    });

    test('hiddenComposite uses the weighted-average composite formula', () => {
      // 3 of 4 pass → 0.75, matching sum(score*w)/sum(w) with equal weights.
      const results: HiddenCaseResult[] = [
        { id: 'a', pass: true },
        { id: 'b', pass: true },
        { id: 'c', pass: true },
        { id: 'd', pass: false },
      ];
      expect(hiddenComposite(results)).toBeCloseTo(0.75, 6);
      expect(hiddenComposite([])).toBe(0);
    });
  });

  describe('AC-E1.6 — gamed change trips the Goodhart flag', () => {
    test('visible rose while hidden stayed flat → goodhartFlag=true', () => {
      const report = buildDivergenceReport(0.12, 0.0);
      expect(report.divergence).toBeCloseTo(0.12, 6);
      expect(report.goodhartFlag).toBe(true);
    });

    test('visible and hidden moved together → no flag', () => {
      const report = buildDivergenceReport(0.12, 0.11);
      expect(report.goodhartFlag).toBe(false);
    });

    test('hidden out-improving visible → no flag', () => {
      const report = buildDivergenceReport(0.02, 0.10);
      expect(report.divergence).toBeLessThan(0);
      expect(report.goodhartFlag).toBe(false);
    });

    test('tolerance boundary is exclusive', () => {
      expect(buildDivergenceReport(DIVERGENCE_TOLERANCE, 0).goodhartFlag).toBe(false);
      expect(buildDivergenceReport(DIVERGENCE_TOLERANCE + 0.001, 0).goodhartFlag).toBe(true);
    });
  });

  describe('scoreHiddenComposite — fail-safe + injection', () => {
    test('returns null when the probe yields nothing (tripwire stays dormant, no false flag)', () => {
      expect(scoreHiddenComposite({ epochKey: '2026-W22', probe: () => null })).toBeNull();
      expect(scoreHiddenComposite({ epochKey: '2026-W22', probe: () => [] })).toBeNull();
    });

    test('composites an injected probe result over the selected partition', () => {
      const score = scoreHiddenComposite({
        epochKey: '2026-W22',
        probe: (bank) => bank.heldoutCaseIds.map((id, i) => ({ id, pass: i % 2 === 0 })),
      });
      expect(score).not.toBeNull();
      expect(score as number).toBeGreaterThanOrEqual(0);
      expect(score as number).toBeLessThanOrEqual(1);
    });

    test('live runner (if reachable) yields a score in [0,1] or null', () => {
      const score = scoreHiddenComposite({ epochKey: '2026-W22' });
      if (score !== null) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });
});

// A self-contained visible set so synthesis/disjointness tests don't depend on the
// external continuation fixture (absent in CI).
const SYNTHETIC_VISIBLE: HoldoutFixtureSet = {
  name: 'visible-stub',
  windowDays: 14,
  threshold: 0.85,
  facts: [{ entity: 'project.health-dashboard' }],
  episodes: [{ entities: ['service.omniroute'] }],
  openLoops: [{ entity: 'project.health-dashboard' }],
  cases: [
    { id: 'health-dashboard-left-off', query: 'where did we leave off?', expectDetection: true, expectAny: ['dashboard', 'vitals'] },
  ],
};

function candidate(over: Partial<ReplenishCandidate>): ReplenishCandidate {
  return {
    title: 'Wire nimbus scheduler retry backoff',
    summary: 'The nimbus scheduler still needs exponential retry backoff wired before launch.',
    kind: 'task',
    status: 'open',
    priority: 0.8,
    entity: 'project.nimbus-scheduler',
    createdDaysAgo: 3,
    updatedDaysAgo: 1,
    ...over,
  };
}

describe('ZOU-279 — held-out bank replenishment', () => {
  describe('AC1 — synthesis mints holdout-namespaced detection cases', () => {
    test('clean candidate yields a holdout- case; colliding candidate is dropped', () => {
      const vocab = new Set(['health', 'dashboard', 'vitals', 'omniroute']);
      const candidates = [
        candidate({}),
        candidate({ title: 'Fix health dashboard stale vitals', entity: 'project.health-dashboard' }),
      ];
      const { cases, openLoops, rejected } = synthesizeHoldoutCases(candidates, vocab, 1_000);

      expect(cases.length).toBe(1);
      expect(openLoops.length).toBe(1);
      expect(rejected).toBeGreaterThanOrEqual(1);

      const c = cases[0];
      expect(c.id.startsWith('holdout-')).toBe(true);
      expect(c.expectDetection).toBe(true);
      expect(c.expectAny.length).toBeGreaterThan(0);
      expect(c.mintedAt).toBe(1_000);
      // No minted needle may collide with the visible vocabulary.
      for (const n of c.expectAny) expect(vocab.has(n)).toBe(false);
    });
  });

  describe('AC2 — provable disjointness from the visible set', () => {
    test('synthesized cases verify disjoint; an injected collision is caught', () => {
      const vocab = buildVisibleVocabulary(SYNTHETIC_VISIBLE);
      const { cases } = synthesizeHoldoutCases([candidate({})], vocab);
      expect(verifyDisjoint({ cases }, SYNTHETIC_VISIBLE).disjoint).toBe(true);

      // id collision
      expect(
        verifyDisjoint({ cases: [{ id: 'health-dashboard-left-off', expectAny: ['x'] }] }, SYNTHETIC_VISIBLE).disjoint
      ).toBe(false);
      // vocab collision
      expect(
        verifyDisjoint({ cases: [{ id: 'holdout-r-x', expectAny: ['dashboard'] }] }, SYNTHETIC_VISIBLE).disjoint
      ).toBe(false);
    });

    test('buildVisibleVocabulary keeps domain tokens, drops generic phrasing', () => {
      const vocab = buildVisibleVocabulary(SYNTHETIC_VISIBLE);
      expect(vocab.has('omniroute')).toBe(true);
      expect(vocab.has('dashboard')).toBe(true);
      expect(vocab.has('project')).toBe(false); // stopword
    });
  });

  describe('rotation cap — newest minted cases retained, oldest evicted', () => {
    test('mergeReplenished keeps at most max, newest by mintedAt', () => {
      const mk = (i: number, minted: number): ReplenishedEntry => ({
        id: `holdout-r-${i}`,
        query: 'q',
        expectDetection: true,
        expectAny: ['t'],
        mintedAt: minted,
        source: 'replenish:open-loop',
        seedLoop: {
          title: 't', summary: 's', kind: 'task', status: 'open', priority: 0.6,
          entity: 'e', createdDaysAgo: 1, updatedDaysAgo: 1,
        },
      });
      const existing = mergeReplenished(null, [mk(1, 100), mk(2, 200)], 5, 300);
      const more = Array.from({ length: REPLENISH_MAX_CASES + 3 }, (_, i) => mk(100 + i, 1000 + i));
      const merged = mergeReplenished(existing, more, REPLENISH_MAX_CASES, 9999);

      expect(merged.entries.length).toBe(REPLENISH_MAX_CASES);
      // oldest (mintedAt 100/200) evicted
      expect(merged.entries.find((e) => e.id === 'holdout-r-1')).toBeUndefined();
      // newest retained, sorted desc
      expect(merged.entries[0].mintedAt).toBeGreaterThanOrEqual(merged.entries[1].mintedAt);
    });
  });

  describe('AC3 — replenish round-trip + freshness, isolated data dir', () => {
    const TMP = join(tmpdir(), `zou279-${process.pid}-${Date.now()}`);
    let origDataDir: string | undefined;

    beforeAll(() => {
      origDataDir = process.env.ZOUROBOROS_DATA_DIR;
      process.env.ZOUROBOROS_DATA_DIR = TMP;
    });
    afterAll(() => {
      if (origDataDir === undefined) delete process.env.ZOUROBOROS_DATA_DIR;
      else process.env.ZOUROBOROS_DATA_DIR = origDataDir;
      rmSync(TMP, { recursive: true, force: true });
    });

    test('mines → writes local bank → merged view + rotation consume it; freshness fresh', () => {
      const seedCount = loadHoldoutFixtures().cases.length;
      const report = replenishHoldoutBank({
        candidates: [
          candidate({}),
          candidate({ title: 'Backfill quasar indexer shard map', entity: 'project.quasar-indexer' }),
        ],
        now: Math.floor(Date.now() / 1000),
      });

      expect(report.added).toBe(2);
      expect(report.disjoint).toBe(true);
      expect(localReplenishBankPath().startsWith(TMP)).toBe(true);

      const bank = loadLocalReplenishedBank();
      expect(bank?.entries.length).toBe(2);

      // merged view exposes seed + minted cases (AC3 rotation consumes them)
      const merged = loadMergedFixtures();
      expect(merged.cases.length).toBe(seedCount + 2);
      const mintedIds = bank!.entries.map((e) => e.id);

      // some epoch's partition includes a minted case
      let consumed = false;
      for (let w = 1; w <= 53 && !consumed; w++) {
        const sel = selectHeldout(`2026-W${String(w).padStart(2, '0')}`, merged);
        if (sel.heldoutCaseIds.some((id) => mintedIds.includes(id))) consumed = true;
      }
      expect(consumed).toBe(true);

      // freshness reflects the just-minted bank
      const f = bankFreshness();
      expect(f.replenishedCount).toBe(2);
      expect(f.stale).toBe(false);
      expect(f.ageDays as number).toBeLessThan(1);
    });
  });
});

describe('P0-3 — HOLDOUT_SUBCHECK display-only parser', () => {
  test('parses detection + content sub-rewards interleaved with HOLDOUT_CASE', () => {
    const out = [
      'HOLDOUT_CASE c1 1',
      'HOLDOUT_SUBCHECK c1 detection 1',
      'HOLDOUT_SUBCHECK c1 content 1',
      'HOLDOUT_CASE c2 0',
      'HOLDOUT_SUBCHECK c2 detection 1',
      'HOLDOUT_SUBCHECK c2 content 0',
      'HOLDOUT_RATE 0.5000',
    ].join('\n');
    const subs = parseHoldoutSubchecks(out);
    expect(subs).toHaveLength(4);
    expect(subs).toContainEqual({ id: 'c1', kind: 'detection', pass: true });
    expect(subs).toContainEqual({ id: 'c2', kind: 'content', pass: false });
  });

  test('isolates which half of a failing case broke', () => {
    const out = [
      'HOLDOUT_CASE c2 0',
      'HOLDOUT_SUBCHECK c2 detection 1',
      'HOLDOUT_SUBCHECK c2 content 0',
    ].join('\n');
    const subs = parseHoldoutSubchecks(out);
    const c2: HoldoutSubcheck[] = subs.filter((s) => s.id === 'c2');
    expect(c2.find((s) => s.kind === 'detection')?.pass).toBe(true);
    expect(c2.find((s) => s.kind === 'content')?.pass).toBe(false);
  });

  test('legacy output with no subcheck lines yields empty (flag-off byte-identical)', () => {
    const out = ['HOLDOUT_CASE c1 1', 'HOLDOUT_CASE c2 1', 'HOLDOUT_RATE 1.0000'].join('\n');
    expect(parseHoldoutSubchecks(out)).toEqual([]);
  });

  test('ignores malformed subcheck lines (unknown kind / non-binary)', () => {
    const out = [
      'HOLDOUT_SUBCHECK c1 detection 1',
      'HOLDOUT_SUBCHECK c1 latency 1',
      'HOLDOUT_SUBCHECK c1 content 2',
    ].join('\n');
    const subs = parseHoldoutSubchecks(out);
    expect(subs).toEqual([{ id: 'c1', kind: 'detection', pass: true }]);
  });
});
