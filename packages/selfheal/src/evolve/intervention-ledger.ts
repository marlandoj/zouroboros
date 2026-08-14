/**
 * Intervention ledger — causal / state-delta logging for prescribe (ZOU-280).
 *
 * Prescribe today is CORRELATIONAL: "metric low → this playbook historically raised
 * it → apply." It has no model of *why* an intervention works, so it cannot judge
 * whether a fix transfers to an unseen regime, nor see the *collateral* state-change a
 * playbook causes (did raising metric A quietly drop metric B?).
 *
 * This ledger records, per evolve run, the structured triple
 *   intervention → { state before, state after, delta }
 * over the FULL scorecard — not just the single target metric — so the loop can reason
 * about transfer instead of pattern-matching on a one-metric correlation.
 *
 * It pairs with the anti-Goodhart held-out tripwire (#1, ZOU-279): #1 tells you THAT the
 * loop drifted; the drift flag joined onto an intervention record here tells you WHICH
 * intervention drifted it (alarm + diagnosis). The ledger is a plain JSON file in the
 * data dir, mirroring evolution-history.json / holdout-fixtures.local.json conventions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from 'zouroboros-core';
import type { ScorecardSnapshot } from '../types.js';

export const INTERVENTION_LEDGER_FILENAME = 'intervention-ledger.json';
export const LEDGER_VERSION = 1;
const MAX_RECORDS = 1000;
/** Per-metric |scoreDelta| above this is reported as a collateral mover (side-effect). */
export const COLLATERAL_DELTA_THRESHOLD = 0.02;

/** Per-metric state change between two scorecard snapshots (normalized score space). */
export interface MetricDelta {
  name: string;
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
}

/** Full-scorecard state change caused by one intervention. */
export interface StateDelta {
  compositeBefore: number;
  compositeAfter: number;
  compositeDelta: number;
  metricDeltas: MetricDelta[];
}

/**
 * Anti-Goodhart divergence joined onto the responsible intervention (AC3). Mirrors
 * DivergenceReport (introspect/holdout.ts) but stored as the causal cross-reference:
 * THIS intervention produced visibleDelta while the hidden bank moved hiddenDelta.
 */
export interface InterventionDrift {
  visibleDelta: number;
  hiddenDelta: number;
  divergence: number;
  goodhartFlag: boolean;
}

export interface InterventionRecord {
  id: string;
  prescriptionId: string;
  playbookId: string;
  playbookName: string;
  metricName: string;
  timestamp: string;
  createdAt: number; // epoch ms
  success: boolean;
  reverted: boolean;
  stateBefore: ScorecardSnapshot;
  stateAfter: ScorecardSnapshot | null;
  stateDelta: StateDelta | null;
  drift: InterventionDrift | null;
}

export interface InterventionLedgerFile {
  version: number;
  entries: InterventionRecord[];
}

/** Aggregated expected state-change for a playbook, surfaced back into prescribe (AC2). */
export interface ExpectedStateChange {
  playbookId: string;
  samples: number;
  successRate: number;
  avgCompositeDelta: number;
  /** Average per-metric scoreDelta across past applications, sorted by |avgDelta| desc. */
  perMetric: { name: string; avgScoreDelta: number; samples: number }[];
  /** True if any past application of this playbook tripped the held-out Goodhart flag. */
  priorGoodhartDrift: boolean;
}

export interface LedgerOptions {
  dataDir?: string;
  now?: number;
}

export function interventionLedgerPath(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), INTERVENTION_LEDGER_FILENAME);
}

export function loadInterventionLedger(dataDir?: string): InterventionLedgerFile {
  const path = interventionLedgerPath(dataDir);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as InterventionLedgerFile;
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    } catch {
      /* corrupt ledger → start fresh rather than crash the loop */
    }
  }
  return { version: LEDGER_VERSION, entries: [] };
}

function saveInterventionLedger(ledger: InterventionLedgerFile, dataDir?: string): void {
  const path = interventionLedgerPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

/**
 * Compute the full-scorecard state delta. Metrics are intersected by name so a snapshot
 * that gained/lost a collector between runs contributes only its shared metrics. Returns
 * null when either composite is non-finite (unmeasurable run).
 */
export function computeStateDelta(
  before: ScorecardSnapshot,
  after: ScorecardSnapshot
): StateDelta | null {
  if (!Number.isFinite(before.composite) || !Number.isFinite(after.composite)) return null;

  const afterByName = new Map(after.metrics.map((m) => [m.name, m]));
  const metricDeltas: MetricDelta[] = [];
  for (const b of before.metrics) {
    const a = afterByName.get(b.name);
    if (!a) continue;
    metricDeltas.push({
      name: b.name,
      scoreBefore: b.score,
      scoreAfter: a.score,
      scoreDelta: a.score - b.score,
    });
  }

  return {
    compositeBefore: before.composite,
    compositeAfter: after.composite,
    compositeDelta: after.composite - before.composite,
    metricDeltas,
  };
}

export interface RecordInterventionInput {
  prescriptionId: string;
  playbookId: string;
  playbookName: string;
  metricName: string;
  success: boolean;
  reverted: boolean;
  stateBefore: ScorecardSnapshot;
  stateAfter: ScorecardSnapshot | null;
  drift?: InterventionDrift | null;
}

/**
 * Persist one intervention → {state before, state after, delta} record (AC1). Appends to
 * the rotating ledger (oldest evicted past MAX_RECORDS) and returns the stored record.
 */
export function recordIntervention(
  input: RecordInterventionInput,
  opts: LedgerOptions = {}
): InterventionRecord {
  const now = opts.now ?? Date.now();
  const ledger = loadInterventionLedger(opts.dataDir);

  const record: InterventionRecord = {
    id: `iv-${now}-${Math.random().toString(36).slice(2, 8)}`,
    prescriptionId: input.prescriptionId,
    playbookId: input.playbookId,
    playbookName: input.playbookName,
    metricName: input.metricName,
    timestamp: new Date(now).toISOString(),
    createdAt: now,
    success: input.success,
    reverted: input.reverted,
    stateBefore: input.stateBefore,
    stateAfter: input.stateAfter,
    stateDelta: input.stateAfter ? computeStateDelta(input.stateBefore, input.stateAfter) : null,
    drift: input.drift ?? null,
  };

  ledger.entries.push(record);
  if (ledger.entries.length > MAX_RECORDS) {
    ledger.entries = ledger.entries.slice(-MAX_RECORDS);
  }
  saveInterventionLedger(ledger, opts.dataDir);
  return record;
}

/**
 * Query intervention history (AC2). Newest first. Filter by playbook and/or target metric.
 */
export function getInterventionHistory(
  filter: { playbookId?: string; metricName?: string; limit?: number } = {},
  dataDir?: string
): InterventionRecord[] {
  let entries = loadInterventionLedger(dataDir).entries;
  if (filter.playbookId) entries = entries.filter((e) => e.playbookId === filter.playbookId);
  if (filter.metricName) entries = entries.filter((e) => e.metricName === filter.metricName);
  entries = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  return filter.limit ? entries.slice(0, filter.limit) : entries;
}

/**
 * Aggregate the expected state-change for a playbook from its history (AC2). Returns null
 * when the playbook has no recorded interventions (correlational fallback still applies).
 */
export function expectedStateChange(
  playbookId: string,
  dataDir?: string
): ExpectedStateChange | null {
  const records = loadInterventionLedger(dataDir).entries.filter(
    (e) => e.playbookId === playbookId
  );
  if (records.length === 0) return null;

  const withDelta = records.filter((e) => e.stateDelta !== null);
  const avgCompositeDelta =
    withDelta.length > 0
      ? withDelta.reduce((s, e) => s + e.stateDelta!.compositeDelta, 0) / withDelta.length
      : 0;

  const perMetricAgg = new Map<string, { total: number; samples: number }>();
  for (const e of withDelta) {
    for (const md of e.stateDelta!.metricDeltas) {
      const agg = perMetricAgg.get(md.name) ?? { total: 0, samples: 0 };
      agg.total += md.scoreDelta;
      agg.samples += 1;
      perMetricAgg.set(md.name, agg);
    }
  }

  const perMetric = [...perMetricAgg.entries()]
    .map(([name, agg]) => ({
      name,
      avgScoreDelta: agg.total / agg.samples,
      samples: agg.samples,
    }))
    .sort((a, b) => Math.abs(b.avgScoreDelta) - Math.abs(a.avgScoreDelta));

  return {
    playbookId,
    samples: records.length,
    successRate: records.filter((e) => e.success).length / records.length,
    avgCompositeDelta,
    perMetric,
    priorGoodhartDrift: records.some((e) => e.drift?.goodhartFlag === true),
  };
}

/**
 * Render an expected state-change as a seed-ready block so the evolve step sees the
 * historical *collateral* effects of this playbook, not just its target-metric trend.
 */
export function formatExpectedStateChange(esc: ExpectedStateChange, targetMetric: string): string {
  const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('historical_state_change:');
  lines.push(`  samples: ${esc.samples}`);
  lines.push(`  success_rate: ${(esc.successRate * 100).toFixed(0)}%`);
  lines.push(`  expected_composite_delta: "${pct(esc.avgCompositeDelta)}"`);

  const target = esc.perMetric.find((m) => m.name === targetMetric);
  if (target) {
    lines.push(`  expected_target_delta: "${pct(target.avgScoreDelta)} on ${targetMetric}"`);
  }

  const collateral = esc.perMetric.filter(
    (m) => m.name !== targetMetric && Math.abs(m.avgScoreDelta) >= COLLATERAL_DELTA_THRESHOLD
  );
  if (collateral.length > 0) {
    lines.push('  collateral_movers:');
    for (const m of collateral.slice(0, 5)) {
      lines.push(`    - "${m.name}: ${pct(m.avgScoreDelta)} avg (${m.samples} samples)"`);
    }
  }
  if (esc.priorGoodhartDrift) {
    lines.push('  prior_goodhart_drift: true  # this playbook has previously tripped the held-out tripwire');
  }
  return lines.join('\n');
}

/**
 * Join an anti-Goodhart drift flag to the responsible intervention record (AC3). Matches
 * the most recent record for the prescription (the intervention that produced visibleDelta)
 * and stamps the drift cross-reference. Returns true if a record was found and updated.
 * Used when divergence is computed in a process separate from the one that recorded the
 * intervention (e.g. a scheduled held-out re-eval), mirroring the ZOU-278 cross-process join.
 */
export function attachDrift(
  prescriptionId: string,
  drift: InterventionDrift,
  dataDir?: string
): boolean {
  const ledger = loadInterventionLedger(dataDir);
  console.error(`  [ledger] attachDrift(${prescriptionId}): scanning ${ledger.entries.length} records`);
  let target: InterventionRecord | null = null;
  for (const e of ledger.entries) {
    if (e.prescriptionId === prescriptionId && (!target || e.createdAt > target.createdAt)) {
      target = e;
    }
  }
  if (!target) {
    console.error(`  [ledger] attachDrift(${prescriptionId}): no matching record found`);
    return false;
  }
  target.drift = drift;
  saveInterventionLedger(ledger, dataDir);
  console.error(`  [ledger] attachDrift(${prescriptionId}): drift attached (goodhartFlag: ${drift.goodhartFlag})`);
  return true;
}

/** All interventions whose joined drift flag tripped the Goodhart tripwire (AC3 query). */
export function interventionsWithDrift(dataDir?: string): InterventionRecord[] {
  return loadInterventionLedger(dataDir)
    .entries.filter((e) => e.drift?.goodhartFlag === true)
    .sort((a, b) => b.createdAt - a.createdAt);
}
