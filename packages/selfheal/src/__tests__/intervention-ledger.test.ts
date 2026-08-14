import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ScorecardSnapshot } from '../types.js';
import {
  recordIntervention,
  computeStateDelta,
  getInterventionHistory,
  expectedStateChange,
  formatExpectedStateChange,
  attachDrift,
  interventionsWithDrift,
  loadInterventionLedger,
  interventionLedgerPath,
  type InterventionDrift,
} from '../evolve/intervention-ledger.js';

function snap(composite: number, metrics: Record<string, number>): ScorecardSnapshot {
  return {
    composite,
    metrics: Object.entries(metrics).map(([name, score]) => ({
      name,
      value: score,
      score,
      status: score >= 0.8 ? 'HEALTHY' : 'WARNING',
    })),
  };
}

const DRIFT: InterventionDrift = {
  visibleDelta: 0.12,
  hiddenDelta: 0.0,
  divergence: 0.12,
  goodhartFlag: true,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iv-ledger-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AC1 — computeStateDelta', () => {
  test('intersects metrics by name and computes composite + per-metric deltas', () => {
    const before = snap(0.7, { 'Memory Recall': 0.5, 'Graph Connectivity': 0.6, 'Gone Next': 0.9 });
    const after = snap(0.75, { 'Memory Recall': 0.8, 'Graph Connectivity': 0.55, 'New Metric': 0.4 });
    const d = computeStateDelta(before, after)!;

    expect(d.compositeDelta).toBeCloseTo(0.05, 6);
    // 'Gone Next' (only in before) and 'New Metric' (only in after) are excluded.
    expect(d.metricDeltas.map((m) => m.name).sort()).toEqual(['Graph Connectivity', 'Memory Recall']);
    const recall = d.metricDeltas.find((m) => m.name === 'Memory Recall')!;
    expect(recall.scoreDelta).toBeCloseTo(0.3, 6);
    const graph = d.metricDeltas.find((m) => m.name === 'Graph Connectivity')!;
    expect(graph.scoreDelta).toBeCloseTo(-0.05, 6);
  });

  test('returns null when a composite is non-finite (unmeasurable run)', () => {
    const before = snap(NaN, { 'Memory Recall': 0.5 });
    const after = snap(0.7, { 'Memory Recall': 0.8 });
    expect(computeStateDelta(before, after)).toBeNull();
  });
});

describe('AC1 — recordIntervention persists the state-delta triple', () => {
  test('writes a record with stateBefore/After/Delta into a fresh ledger', () => {
    const rec = recordIntervention(
      {
        prescriptionId: 'rx-1',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: true,
        reverted: false,
        stateBefore: snap(0.7, { 'Memory Recall': 0.5 }),
        stateAfter: snap(0.78, { 'Memory Recall': 0.8 }),
      },
      { dataDir: dir, now: 1000 }
    );

    expect(rec.stateDelta).not.toBeNull();
    expect(rec.stateDelta!.compositeDelta).toBeCloseTo(0.08, 6);

    const ledger = loadInterventionLedger(dir);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].prescriptionId).toBe('rx-1');
    expect(interventionLedgerPath(dir)).toBe(join(dir, 'intervention-ledger.json'));
  });

  test('null stateAfter yields a null stateDelta but still persists the intervention', () => {
    recordIntervention(
      {
        prescriptionId: 'rx-fail',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: false,
        reverted: false,
        stateBefore: snap(0.7, { 'Memory Recall': 0.5 }),
        stateAfter: null,
      },
      { dataDir: dir, now: 2000 }
    );
    const ledger = loadInterventionLedger(dir);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].stateDelta).toBeNull();
  });
});

describe('AC2 — query history + aggregate expected state-change', () => {
  beforeEach(() => {
    // Two applications of A-recall (one success, one failure-with-drift) + one B-graph.
    recordIntervention(
      {
        prescriptionId: 'rx-a1',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: true,
        reverted: false,
        stateBefore: snap(0.70, { 'Memory Recall': 0.50, 'Graph Connectivity': 0.60 }),
        stateAfter: snap(0.76, { 'Memory Recall': 0.70, 'Graph Connectivity': 0.55 }),
      },
      { dataDir: dir, now: 1000 }
    );
    recordIntervention(
      {
        prescriptionId: 'rx-a2',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: false,
        reverted: true,
        stateBefore: snap(0.72, { 'Memory Recall': 0.55, 'Graph Connectivity': 0.60 }),
        stateAfter: snap(0.74, { 'Memory Recall': 0.65, 'Graph Connectivity': 0.59 }),
        drift: DRIFT,
      },
      { dataDir: dir, now: 2000 }
    );
    recordIntervention(
      {
        prescriptionId: 'rx-b1',
        playbookId: 'B-graph',
        playbookName: 'Graph linker',
        metricName: 'Graph Connectivity',
        success: true,
        reverted: false,
        stateBefore: snap(0.70, { 'Graph Connectivity': 0.40 }),
        stateAfter: snap(0.80, { 'Graph Connectivity': 0.70 }),
      },
      { dataDir: dir, now: 3000 }
    );
  });

  test('getInterventionHistory filters by playbook and returns newest first', () => {
    const hist = getInterventionHistory({ playbookId: 'A-recall' }, dir);
    expect(hist).toHaveLength(2);
    expect(hist[0].prescriptionId).toBe('rx-a2'); // newest (now=2000) first
    expect(hist[1].prescriptionId).toBe('rx-a1');
  });

  test('getInterventionHistory filters by metric name', () => {
    const hist = getInterventionHistory({ metricName: 'Graph Connectivity' }, dir);
    expect(hist).toHaveLength(1);
    expect(hist[0].playbookId).toBe('B-graph');
  });

  test('expectedStateChange aggregates success rate, composite + per-metric deltas, prior drift', () => {
    const esc = expectedStateChange('A-recall', dir)!;
    expect(esc.samples).toBe(2);
    expect(esc.successRate).toBeCloseTo(0.5, 6);
    // composite deltas: +0.06 and +0.02 → avg +0.04
    expect(esc.avgCompositeDelta).toBeCloseTo(0.04, 6);
    // Memory Recall deltas: +0.20 and +0.10 → avg +0.15
    const recall = esc.perMetric.find((m) => m.name === 'Memory Recall')!;
    expect(recall.avgScoreDelta).toBeCloseTo(0.15, 6);
    expect(recall.samples).toBe(2);
    // perMetric sorted by |avgScoreDelta| desc → Memory Recall (0.15) before Graph (≈-0.03)
    expect(esc.perMetric[0].name).toBe('Memory Recall');
    expect(esc.priorGoodhartDrift).toBe(true);
  });

  test('expectedStateChange returns null for an unseen playbook', () => {
    expect(expectedStateChange('NEVER-RUN', dir)).toBeNull();
  });

  test('formatExpectedStateChange surfaces target delta, collateral movers, and drift', () => {
    const esc = expectedStateChange('A-recall', dir)!;
    const text = formatExpectedStateChange(esc, 'Memory Recall');
    expect(text).toContain('samples: 2');
    expect(text).toContain('success_rate: 50%');
    expect(text).toContain('Memory Recall');
    expect(text).toContain('collateral_movers'); // Graph Connectivity moved ≈ -3% ≥ 2% threshold
    expect(text).toContain('prior_goodhart_drift: true');
  });
});

describe('AC3 — join a held-out drift flag to the responsible intervention', () => {
  test('drift supplied at record time is queryable via interventionsWithDrift', () => {
    recordIntervention(
      {
        prescriptionId: 'rx-d',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: false,
        reverted: false,
        stateBefore: snap(0.7, { 'Memory Recall': 0.5 }),
        stateAfter: snap(0.82, { 'Memory Recall': 0.9 }),
        drift: DRIFT,
      },
      { dataDir: dir, now: 1000 }
    );
    const flagged = interventionsWithDrift(dir);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].prescriptionId).toBe('rx-d');
    expect(flagged[0].drift!.goodhartFlag).toBe(true);
  });

  test('attachDrift joins a flag to the most recent record for a prescription', () => {
    recordIntervention(
      {
        prescriptionId: 'rx-x',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: true,
        reverted: false,
        stateBefore: snap(0.7, { 'Memory Recall': 0.5 }),
        stateAfter: snap(0.75, { 'Memory Recall': 0.7 }),
      },
      { dataDir: dir, now: 1000 }
    );
    // Same prescription re-run later (e.g. retried); newer record should win the join.
    recordIntervention(
      {
        prescriptionId: 'rx-x',
        playbookId: 'A-recall',
        playbookName: 'Recall fixer',
        metricName: 'Memory Recall',
        success: true,
        reverted: false,
        stateBefore: snap(0.7, { 'Memory Recall': 0.5 }),
        stateAfter: snap(0.78, { 'Memory Recall': 0.8 }),
      },
      { dataDir: dir, now: 2000 }
    );

    expect(interventionsWithDrift(dir)).toHaveLength(0);
    const ok = attachDrift('rx-x', DRIFT, dir);
    expect(ok).toBe(true);

    const flagged = interventionsWithDrift(dir);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].createdAt).toBe(2000); // the most recent record was joined
  });

  test('attachDrift returns false when no record matches the prescription', () => {
    expect(attachDrift('does-not-exist', DRIFT, dir)).toBe(false);
  });
});
