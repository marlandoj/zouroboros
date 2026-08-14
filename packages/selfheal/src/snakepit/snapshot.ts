/**
 * Snake Pit snapshot regression guardrail (ZOU-294).
 *
 * The sweep runner (ZOU-292) diffs each sweep against the PREVIOUS one — a rolling, drifting
 * comparison that answers "did this run get worse than last run?". This guardrail answers the
 * stricter question the self-improvement loop actually needs: "is the loop's adversarial
 * robustness still at least as good as the state a human ratified?". It diffs the current sweep
 * against a COMMITTED baseline (baseline-snapshot.json, reviewed in a PR like parity-manifest.json
 * / holdout-fixtures.json) rather than the last runtime sweep. The baseline is a ratchet: it only
 * moves forward when a human re-baselines (--update-baseline) after a deliberate, ratified
 * improvement, so a self-modification that quietly makes a fixture newly take bait, newly fail, or
 * drops the applicable pass rate trips the gate even if the previous rolling sweep already drifted.
 *
 * Discipline mirrors the Wiring Sentinel / parity tripwire: REPORT-and-ESCALATE, fail-safe.
 *   - current report unmeasurable (runner missing/unparseable) → null, never a phantom regression.
 *   - no committed baseline yet → status 'no-baseline', ok=true (can't assert; non-blocking until
 *     a baseline is ratified) so CI does not block before the first --update-baseline.
 *
 * Reuses sweep.ts's computeDelta so "regression vs baseline" and "regression vs previous sweep"
 * are graded by one definition. Type-checked (no bun:sqlite / Skills imports); the live report
 * comes from sweep.runHarness(), which shells out to the tsc-excluded standalone runner.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { SnakePitReport } from './inject.js';
import { computeDelta, runHarness, type SweepRecord, type SweepDelta } from './sweep.js';

const WORKSPACE = getWorkspaceRoot();

const BASELINE_CANDIDATES = [
  fileURLToPath(new URL('./baseline-snapshot.json', import.meta.url)),
  join(WORKSPACE, 'packages/selfheal/src/snakepit/baseline-snapshot.json'),
  join(WORKSPACE, 'Skills/zouroboros/skills/selfheal/scripts/baseline-snapshot.json'),
];

export type SnapshotStatus = 'ok' | 'regression' | 'no-baseline';

export interface SnapshotGuard {
  status: SnapshotStatus;
  /** False only when status === 'regression'. 'no-baseline' is non-blocking (nothing to assert). */
  ok: boolean;
  /** Delta vs the committed baseline; null when there is no baseline to diff against. */
  delta: SweepDelta | null;
  /** The current report this check graded. */
  report: SnakePitReport;
  /** sweepId / timestamp of the committed baseline, or null when none exists. */
  baselineSweepId: string | null;
  baselineTimestamp: string | null;
}

export interface CheckSnapshotOptions {
  /** Injectable report producer for tests; defaults to the live standalone runner. */
  produceReport?: () => SnakePitReport | null;
  /** Override the baseline search path (tests). */
  baselinePath?: string;
  /**
   * Injected baseline record (tests). Pass `null` to force the no-baseline path; omit to read
   * from disk. Distinguishing undefined-vs-null lets a test assert no-baseline without disk I/O.
   */
  baseline?: SweepRecord | null;
}

/** Canonical write location for the committed baseline (next to this module's source). */
export function baselineWritePath(): string {
  return fileURLToPath(new URL('./baseline-snapshot.json', import.meta.url));
}

export function findBaselinePath(candidates: string[] = BASELINE_CANDIDATES): string | null {
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** Load the committed baseline SweepRecord, or null when none exists / unparseable. */
export function loadBaseline(path?: string): SweepRecord | null {
  const p = path ?? findBaselinePath();
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SweepRecord;
  } catch {
    return null;
  }
}

/** Persist a record as the committed baseline (the human-ratified ratchet step). */
export function writeBaseline(record: SweepRecord, path: string = baselineWritePath()): string {
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return path;
}

/**
 * Diff the current sweep against the committed baseline. Returns null only when the current
 * report is unmeasurable (fail-safe — never a phantom regression). When no baseline exists the
 * guard is non-blocking ('no-baseline', ok=true): the gate cannot assert a regression against a
 * floor that has not been ratified yet.
 */
export function checkSnapshot(opts: CheckSnapshotOptions = {}): SnapshotGuard | null {
  const report = opts.produceReport ? opts.produceReport() : runHarness();
  if (!report) return null;

  const baseline = opts.baseline !== undefined ? opts.baseline : loadBaseline(opts.baselinePath);
  if (!baseline) {
    return {
      status: 'no-baseline',
      ok: true,
      delta: null,
      report,
      baselineSweepId: null,
      baselineTimestamp: null,
    };
  }

  const delta = computeDelta(report, baseline);
  return {
    status: delta.regression ? 'regression' : 'ok',
    ok: !delta.regression,
    delta,
    report,
    baselineSweepId: baseline.sweepId,
    baselineTimestamp: baseline.timestamp,
  };
}

/** One-line-per-section human summary for the CI gate / scheduled guardrail agent. */
export function summarizeSnapshot(guard: SnapshotGuard): string {
  const r = guard.report;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines: string[] = [];
  lines.push(
    `Snake Pit snapshot — pass ${r.passed}/${r.applicable} (${pct(r.passRate)}), baited ${r.baited.length}`
  );

  if (guard.status === 'no-baseline') {
    lines.push('  (no committed baseline — run with --update-baseline to ratify the current state)');
    return lines.join('\n');
  }

  const d = guard.delta!;
  const dir = d.passRateDelta >= 0 ? '+' : '';
  lines.push(
    `  vs baseline ${guard.baselineSweepId!.slice(0, 8)} (${guard.baselineTimestamp}): passRate ${dir}${(
      d.passRateDelta * 100
    ).toFixed(1)}pp`
  );
  if (guard.status === 'regression') {
    lines.push(
      `  ⚠ REGRESSION vs baseline — newlyFailed=[${d.newlyFailed.join(', ')}] newlyBaited=[${d.newlyBaited.join(
        ', '
      )}] regressedArchetypes=[${d.regressedArchetypes.join(', ')}]`
    );
  } else {
    lines.push('  ✓ no regression vs baseline');
  }
  return lines.join('\n');
}

// CLI:
//   bun src/snakepit/snapshot.ts                  check current sweep vs committed baseline
//                                                 (exit 0 = ok/no-baseline, 1 = regression, 2 = unmeasurable)
//   bun src/snakepit/snapshot.ts --update-baseline ratify the current live sweep as the new baseline
if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2);

  if (args.includes('--update-baseline')) {
    const report = runHarness();
    if (!report) {
      console.error('Snake Pit snapshot unmeasurable (runner missing or unparseable) — baseline not updated');
      process.exit(2);
    }
    const record: SweepRecord = {
      sweepId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      report,
    };
    const path = writeBaseline(record);
    console.log(
      `Baseline ratified: ${record.sweepId.slice(0, 8)} — pass ${report.passed}/${report.applicable}, baited ${report.baited.length} → ${path}`
    );
    process.exit(0);
  }

  const guard = checkSnapshot();
  if (!guard) {
    console.error('Snake Pit snapshot unmeasurable (runner missing or unparseable)');
    process.exit(2);
  }
  console.log(summarizeSnapshot(guard));
  console.log(`SNAPSHOT_STATUS ${guard.status}`);
  console.log(`SNAPSHOT_JSON ${JSON.stringify(guard)}`);
  process.exit(guard.status === 'regression' ? 1 : 0);
}
