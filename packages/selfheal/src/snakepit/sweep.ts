/**
 * The Snake Pit — automated red-team sweep runner (ZOU-292).
 *
 * Wraps the ZOU-291 injection harness in repeatable automation: drive the harness, persist
 * a timestamped sweep record, and diff it against the previous sweep so a regression (the
 * loop newly taking bait, or a drop in the applicable pass rate) is a first-class signal the
 * dashboard (ZOU-293) and snapshot guardrail (ZOU-294) consume.
 *
 * Mirrors holdout.ts's relationship to standalone/holdout-eval.ts: this file is type-checked
 * (no bun:sqlite / Skills imports) and shells out to the tsc-excluded standalone runner
 * (standalone/snakepit-eval.ts) for the bun:sqlite + continuation-module work. When the runner
 * is unavailable or unparseable the sweep returns null (fail-safe) rather than fabricating a
 * zero-score "regression".
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { SnakePitReport, FixtureVerdict } from './inject.js';
import { ARCHETYPE_IDS, type ArchetypeId } from './taxonomy.js';

const WORKSPACE = getWorkspaceRoot();
const SWEEPS_DIR = join(WORKSPACE, 'Seeds/zouroboros/snakepit');
const REPLAY_RUNNER = join(WORKSPACE, 'packages/bench/scripts/replay-regression.ts');

const RUNNER_CANDIDATES = [
  fileURLToPath(new URL('../standalone/snakepit-eval.ts', import.meta.url)),
  join(WORKSPACE, 'packages/selfheal/src/standalone/snakepit-eval.ts'),
  join(WORKSPACE, 'Skills/zouroboros/skills/selfheal/scripts/snakepit-eval.ts'),
];

export interface SweepRecord {
  sweepId: string;
  timestamp: string;
  report: SnakePitReport;
}

export interface SweepDelta {
  previousSweepId: string | null;
  previousTimestamp: string | null;
  /** current.passRate - previous.passRate; negative = regression. */
  passRateDelta: number;
  /** Fixture ids baited now but not in the previous sweep. */
  newlyBaited: string[];
  /** Fixture ids failing now that passed (or were skipped→applicable) before. */
  newlyFailed: string[];
  /** Archetypes whose pass fraction dropped vs the previous sweep. */
  regressedArchetypes: ArchetypeId[];
  /** True when the pass rate dropped, a new fixture took bait, or a new fixture failed. */
  regression: boolean;
}

export interface SweepResult {
  record: SweepRecord;
  /** Where the record was written, or null when persist was skipped. */
  persistedPath: string | null;
  delta: SweepDelta;
  replay: ReplayGateSummary;
}

export interface ReplayGateSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

export interface RunSweepOptions {
  /** Injectable report producer for tests; defaults to the live standalone runner. */
  produceReport?: () => SnakePitReport | null;
  /** When false, do not write the record to disk (tests). Default true. */
  persist?: boolean;
  /** Injectable deterministic replay result. Live sweeps invoke the shared corpus runner. */
  produceReplay?: () => ReplayGateSummary;
}

function runReplayGate(): ReplayGateSummary {
  if (!existsSync(REPLAY_RUNNER)) return { total: 0, passed: 0, failed: 0, errors: 1 };
  const result = spawnSync(
    'bun',
    [REPLAY_RUNNER, '--target', 'snakepit', '--root', WORKSPACE, '--json'],
    { cwd: WORKSPACE, timeout: 120_000, encoding: 'utf8' },
  );
  try {
    const parsed = JSON.parse(result.stdout.trim()) as ReplayGateSummary;
    if (typeof parsed.total !== 'number') throw new Error('invalid replay summary');
    return parsed;
  } catch {
    return { total: 0, passed: 0, failed: 0, errors: 1 };
  }
}

function findRunner(): string | null {
  for (const p of RUNNER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/** Run the standalone harness once and parse its single SNAKE_REPORT line. Null when unmeasurable. */
export function runHarness(): SnakePitReport | null {
  const runner = findRunner();
  if (!runner) return null;
  try {
    const out = execSync(`bun "${runner}" 2>/dev/null`, { cwd: WORKSPACE, timeout: 120000, encoding: 'utf-8' });
    for (const line of out.split('\n')) {
      const m = line.match(/^SNAKE_REPORT\s+(.+)$/);
      if (m) return JSON.parse(m[1]) as SnakePitReport;
    }
    return null;
  } catch {
    return null;
  }
}

/** Load the most recent persisted sweep (by timestamp), or null when none exists. */
export function loadPreviousSweep(dir: string = SWEEPS_DIR): SweepRecord | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('-sweep.json'));
  let latest: SweepRecord | null = null;
  for (const f of files) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SweepRecord;
      if (!latest || rec.timestamp > latest.timestamp) latest = rec;
    } catch {
      // skip unparseable records
    }
  }
  return latest;
}

function statusById(report: SnakePitReport): Map<string, FixtureVerdict['status']> {
  return new Map(report.verdicts.map((v) => [v.id, v.status]));
}

function archetypePassFrac(report: SnakePitReport, id: ArchetypeId): number {
  const r = report.byArchetype[id];
  return r.applicable === 0 ? 0 : r.passed / r.applicable;
}

export function computeDelta(current: SnakePitReport, previous: SweepRecord | null): SweepDelta {
  if (!previous) {
    return {
      previousSweepId: null,
      previousTimestamp: null,
      passRateDelta: 0,
      newlyBaited: [],
      newlyFailed: [],
      regressedArchetypes: [],
      regression: false,
    };
  }

  const prevReport = previous.report;
  const prevBaited = new Set(prevReport.baited);
  const newlyBaited = current.baited.filter((id) => !prevBaited.has(id));

  const prevStatus = statusById(prevReport);
  const newlyFailed = current.verdicts
    .filter((v) => v.status === 'fail' && prevStatus.get(v.id) !== 'fail')
    .map((v) => v.id);

  const regressedArchetypes = ARCHETYPE_IDS.filter(
    (id) => archetypePassFrac(current, id) < archetypePassFrac(prevReport, id) - 1e-9
  );

  const passRateDelta = current.passRate - prevReport.passRate;
  const regression = passRateDelta < -1e-9 || newlyBaited.length > 0 || newlyFailed.length > 0;

  return {
    previousSweepId: previous.sweepId,
    previousTimestamp: previous.timestamp,
    passRateDelta,
    newlyBaited,
    newlyFailed,
    regressedArchetypes,
    regression,
  };
}

/**
 * Run a full sweep: produce a report (live runner or injected), diff against the previous
 * persisted sweep, persist this one, and return the record + delta. Returns null only when
 * the report itself is unmeasurable (fail-safe — no phantom regression).
 */
export function runSweep(opts: RunSweepOptions = {}): SweepResult | null {
  const report = opts.produceReport ? opts.produceReport() : runHarness();
  if (!report) return null;

  const previous = loadPreviousSweep();
  const delta = computeDelta(report, previous);
  const replay = opts.produceReplay
    ? opts.produceReplay()
    : opts.produceReport
      ? { total: 0, passed: 0, failed: 0, errors: 0 }
      : runReplayGate();

  const record: SweepRecord = {
    sweepId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    report,
  };

  let persistedPath: string | null = null;
  if (opts.persist !== false) {
    if (!existsSync(SWEEPS_DIR)) mkdirSync(SWEEPS_DIR, { recursive: true });
    persistedPath = join(SWEEPS_DIR, `${record.sweepId}-sweep.json`);
    // Persist the delta alongside the record so the read-only dashboard API can render
    // regression state without recomputing it.
    writeFileSync(persistedPath, JSON.stringify({ ...record, delta, replay }, null, 2));
  }

  return { record, persistedPath, delta, replay };
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** One-line-per-section human summary for the scheduled sweep agent / CLI. */
export function summarizeSweep(result: SweepResult): string {
  const { record, delta } = result;
  const r = record.report;
  const lines: string[] = [];
  lines.push(
    `Snake Pit sweep ${record.sweepId.slice(0, 8)} — pass ${r.passed}/${r.applicable} (${fmtPct(
      r.passRate
    )}), ${r.skipped} skipped, baited ${r.baited.length}`
  );
  for (const id of ARCHETYPE_IDS) {
    const a = r.byArchetype[id];
    lines.push(`  ${id}: pass ${a.passed}/${a.applicable} (skip ${a.skipped})`);
  }
  if (delta.previousSweepId) {
    const dir = delta.passRateDelta >= 0 ? '+' : '';
    lines.push(`  Δ vs ${delta.previousSweepId.slice(0, 8)}: passRate ${dir}${(delta.passRateDelta * 100).toFixed(1)}pp`);
    if (delta.regression) {
      lines.push(
        `  ⚠ REGRESSION — newlyFailed=[${delta.newlyFailed.join(', ')}] newlyBaited=[${delta.newlyBaited.join(
          ', '
        )}] regressedArchetypes=[${delta.regressedArchetypes.join(', ')}]`
      );
    } else {
      lines.push('  ✓ no regression');
    }
  } else {
    lines.push('  (first sweep — no baseline to diff)');
  }
  lines.push(
    `  replay: ${result.replay.passed}/${result.replay.total} passed, ${result.replay.failed} failed, ${result.replay.errors} errors`,
  );
  return lines.join('\n');
}

// CLI: `bun src/snakepit/sweep.ts` runs a live sweep, prints the summary, and emits SWEEP_JSON.
if ((import.meta as { main?: boolean }).main) {
  const result = runSweep();
  if (!result) {
    console.error('Snake Pit sweep unmeasurable (runner missing or unparseable)');
    process.exit(2);
  }
  console.log(summarizeSweep(result));
  const replayRegression = result.replay.failed > 0 || result.replay.errors > 0;
  console.log(`SWEEP_REGRESSION ${result.delta.regression || replayRegression ? 1 : 0}`);
  console.log(`SWEEP_JSON ${JSON.stringify(result)}`);
  if (replayRegression) process.exit(1);
}
