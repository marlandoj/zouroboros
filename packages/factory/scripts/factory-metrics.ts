#!/usr/bin/env bun
/**
 * T3 (SF-004) — Factory Metrics Aggregation
 *
 * Pure computeFactoryMetrics(records, opts) over FactoryRecords from
 * state/factory-log.jsonl. Every rate carries its explicit denominator and
 * null (never 0 or 1) when the denominator is empty — no silent division.
 *
 * Honesty invariants:
 *  - first_pass_yield / rework_rate use ONLY sidecar-derived verdict fields
 *    (record.measured / record.verdict); unmeasured runs sit in
 *    unmeasured_count and can never inflate yield.
 *  - throughput counts only units with a known ISO activity stamp inside the
 *    window; undatable units (all stamps "unknown") are reported separately,
 *    never guessed into a day bucket.
 *  - stage drop-off separates reached-with-timestamp from reached-unknown-time.
 *
 * Usage:
 *   bun factory-metrics.ts report [--window <days>] [--json]
 */

import {
  defaultSources,
  readFactoryLog,
  type FactoryRecord,
  type StageName,
} from "./factory-collect";
import {
  computeSurvivability,
  loadSurvivabilityConfig,
  readFateLedger,
  sf012Flags,
  type SurvivabilityReport,
  type SurvivalBucket,
} from "./survivability-core";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StageDropoff {
  reached: number;
  timestamped: number;
  unknown_time: number;
}

export interface FactoryMetrics {
  window_days: number;
  total_units: number;
  measured_count: number;
  unmeasured_count: number;
  // throughput
  throughput_window_units: number;
  throughput_per_day: number;
  undatable_units: number;
  // yield (denominator: measured_count)
  first_pass_count: number;
  first_pass_yield: number | null;
  rework_count: number;
  rework_rate: number | null;
  fail_count: number;
  // gate (denominator: gate_classified_count = units with a recorded gate decision)
  gate_classified_count: number;
  held_count: number;
  gate_rejection_rate: number | null;
  auto_approval_ratio: number | null;
  // cycle time (denominator: cycle_time_count)
  cycle_time_count: number;
  mean_cycle_time_hours: number | null;
  // stages
  stage_dropoff: Record<StageName, StageDropoff>;
  // SF-011: per-archetype drill-down; records without a recorded archetype
  // bucket under "unrecorded" (pre-SF-011 runs / flag off), never guessed.
  by_archetype: Record<string, ArchetypeSlice>;
  computed_at: string;
}

export interface ArchetypeSlice {
  units: number;
  measured: number;
  first_pass: number;
  first_pass_yield: number | null;
  rework: number;
  failed: number;
}

const STAGE_ORDER: StageName[] = ["decision", "seed", "execute", "postflight", "pr"];

// ─── Pure aggregation ─────────────────────────────────────────────────────────

/** Latest known ISO stamp across stages; null when every stamp is unknown/null. */
export function latestActivity(rec: FactoryRecord): string | null {
  let latest: string | null = null;
  for (const stage of STAGE_ORDER) {
    const stamp = rec.stages[stage];
    if (stamp === null || stamp === "unknown") continue;
    if (Number.isNaN(Date.parse(stamp))) continue;
    if (latest === null || Date.parse(stamp) > Date.parse(latest)) latest = stamp;
  }
  return latest;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export function computeFactoryMetrics(
  records: FactoryRecord[],
  opts: { windowDays?: number; now?: string } = {},
): FactoryMetrics {
  const windowDays = opts.windowDays ?? 7;
  const nowIso = opts.now ?? new Date().toISOString();
  const windowStart = Date.parse(nowIso) - windowDays * 86_400_000;

  const measured = records.filter((r) => r.measured && r.verdict !== null);
  const firstPass = measured.filter((r) => r.verdict!.verdict === "pass" && !r.verdict!.rework);
  const rework = measured.filter((r) => r.verdict!.rework);
  const failed = measured.filter((r) => r.verdict!.verdict === "fail");

  let windowUnits = 0;
  let undatable = 0;
  for (const rec of records) {
    const activity = latestActivity(rec);
    if (activity === null) {
      undatable++;
      continue;
    }
    const t = Date.parse(activity);
    if (t >= windowStart && t <= Date.parse(nowIso)) windowUnits++;
  }

  const gateClassified = records.filter((r) => r.gate_decision !== "unknown");
  const held = gateClassified.filter((r) => r.status === "held");

  const cycles = records
    .map((r) => r.cycle_time_hours)
    .filter((c): c is number => c !== null);

  const by_archetype: Record<string, ArchetypeSlice> = {};
  for (const rec of records) {
    const key = rec.archetype ?? "unrecorded";
    const slice = (by_archetype[key] ??= { units: 0, measured: 0, first_pass: 0, first_pass_yield: null, rework: 0, failed: 0 });
    slice.units++;
    if (rec.measured && rec.verdict !== null) {
      slice.measured++;
      if (rec.verdict.verdict === "pass" && !rec.verdict.rework) slice.first_pass++;
      if (rec.verdict.rework) slice.rework++;
      if (rec.verdict.verdict === "fail") slice.failed++;
    }
  }
  for (const slice of Object.values(by_archetype)) {
    slice.first_pass_yield = ratio(slice.first_pass, slice.measured);
  }

  const stage_dropoff = {} as Record<StageName, StageDropoff>;
  for (const stage of STAGE_ORDER) {
    const reachedRecs = records.filter((r) => r.stages[stage] !== null);
    const unknownTime = reachedRecs.filter((r) => r.stages[stage] === "unknown");
    stage_dropoff[stage] = {
      reached: reachedRecs.length,
      timestamped: reachedRecs.length - unknownTime.length,
      unknown_time: unknownTime.length,
    };
  }

  return {
    window_days: windowDays,
    total_units: records.length,
    measured_count: measured.length,
    unmeasured_count: records.length - measured.length,
    throughput_window_units: windowUnits,
    throughput_per_day: windowDays > 0 ? Math.round((windowUnits / windowDays) * 100) / 100 : 0,
    undatable_units: undatable,
    first_pass_count: firstPass.length,
    first_pass_yield: ratio(firstPass.length, measured.length),
    rework_count: rework.length,
    rework_rate: ratio(rework.length, measured.length),
    fail_count: failed.length,
    gate_classified_count: gateClassified.length,
    held_count: held.length,
    gate_rejection_rate: ratio(held.length, gateClassified.length),
    auto_approval_ratio: ratio(gateClassified.length - held.length, gateClassified.length),
    cycle_time_count: cycles.length,
    mean_cycle_time_hours:
      cycles.length === 0
        ? null
        : Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100,
    stage_dropoff,
    by_archetype,
    computed_at: nowIso,
  };
}

// ─── Report rendering ─────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v === null ? "n/a (0 denominator)" : `${(v * 100).toFixed(1)}%`;
}

export function renderReport(m: FactoryMetrics): string {
  const lines: string[] = [];
  lines.push(`# Factory Metrics — last ${m.window_days}d (computed ${m.computed_at})`);
  lines.push("");
  lines.push(`| Metric | Value | Denominator |`);
  lines.push(`|--------|-------|-------------|`);
  lines.push(`| Units (all-time) | ${m.total_units} | — |`);
  lines.push(`| Throughput | ${m.throughput_per_day}/day (${m.throughput_window_units} in window) | dated units; ${m.undatable_units} undatable excluded |`);
  lines.push(`| First-pass yield | ${pct(m.first_pass_yield)} (${m.first_pass_count}) | ${m.measured_count} measured |`);
  lines.push(`| Rework rate | ${pct(m.rework_rate)} (${m.rework_count}) | ${m.measured_count} measured |`);
  lines.push(`| Failed | ${m.fail_count} | ${m.measured_count} measured |`);
  lines.push(`| Unmeasured | ${m.unmeasured_count} | ${m.total_units} units — never counted as passed |`);
  lines.push(`| Gate rejection (held) | ${pct(m.gate_rejection_rate)} (${m.held_count}) | ${m.gate_classified_count} gate-classified |`);
  lines.push(`| Auto-approval ratio | ${pct(m.auto_approval_ratio)} | ${m.gate_classified_count} gate-classified |`);
  lines.push(`| Mean cycle time | ${m.mean_cycle_time_hours === null ? "n/a" : `${m.mean_cycle_time_hours}h`} | ${m.cycle_time_count} with full decision→postflight stamps |`);
  lines.push("");
  lines.push(`## Stage drop-off (decision → seed → execute → post-flight → PR)`);
  lines.push("");
  lines.push(`| Stage | Reached | Timestamped | Unknown time |`);
  lines.push(`|-------|---------|-------------|--------------|`);
  for (const stage of STAGE_ORDER) {
    const d = m.stage_dropoff[stage];
    lines.push(`| ${stage} | ${d.reached} | ${d.timestamped} | ${d.unknown_time} |`);
  }
  const archetypeKeys = Object.keys(m.by_archetype).filter((k) => k !== "unrecorded").sort();
  if (archetypeKeys.length > 0) {
    lines.push("");
    lines.push(`## By archetype (SF-011 assembly lines)`);
    lines.push("");
    lines.push(`| Line | Units | Measured | First-pass yield | Rework | Failed |`);
    lines.push(`|------|-------|----------|------------------|--------|--------|`);
    for (const key of [...archetypeKeys, ...(m.by_archetype.unrecorded ? ["unrecorded"] : [])]) {
      const s = m.by_archetype[key];
      lines.push(`| ${key} | ${s.units} | ${s.measured} | ${pct(s.first_pass_yield)} (${s.first_pass}) | ${s.rework} | ${s.failed} |`);
    }
  }
  return lines.join("\n");
}

// ─── SF-012 trailing quality (behind SF012_SURVIVAL — flag off ⇒ byte-identical) ─

/**
 * TRAILING quality = post-merge fate (did the code survive out there?), a
 * deliberately separate axis from FIRST-PASS yield above (did it pass its own
 * post-flight?). Min-sample honesty: no rate renders below min_sample.
 */
export function renderTrailingQuality(report: SurvivabilityReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`## Trailing quality (SF-012 post-merge survivability — distinct from first-pass yield)`);
  lines.push("");
  const rate = (b: SurvivalBucket) =>
    b.insufficient_data
      ? `insufficient data (n=${b.n} < ${report.min_sample})`
      : `${((b.survival_rate ?? 0) * 100).toFixed(1)}%`;
  lines.push(`| Bucket | n | Survived | Reverted | Hotfixed | Survival rate |`);
  lines.push(`|--------|---|----------|----------|----------|---------------|`);
  lines.push(
    `| global | ${report.global.n} | ${report.global.survived} | ${report.global.reverted} | ${report.global.hotfixed} | ${rate(report.global)} |`,
  );
  for (const key of Object.keys(report.by_archetype).sort()) {
    const b = report.by_archetype[key];
    lines.push(`| ${key} | ${b.n} | ${b.survived} | ${b.reverted} | ${b.hotfixed} | ${rate(b)} |`);
  }
  if (report.distinct_prs === 0) {
    lines.push("");
    lines.push(`_No merged agent PRs probed yet — trailing quality is unmeasurable by design (no synthetic data)._`);
  }
  return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd] = args;
  if (cmd !== "report") {
    console.error("usage: factory-metrics.ts report [--window <days>] [--json]");
    process.exit(2);
  }
  const wIdx = args.indexOf("--window");
  let windowDays = 7;
  if (wIdx !== -1) {
    windowDays = Number(args[wIdx + 1]);
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      console.error(`--window must be a positive number of days (got ${JSON.stringify(args[wIdx + 1])})`);
      process.exit(2);
    }
  }
  const records = [...readFactoryLog(defaultSources().logPath).values()];
  const metrics = computeFactoryMetrics(records, { windowDays });
  // SF-012: trailing-quality section rides the same report ONLY when
  // SF012_SURVIVAL=1 — flag off keeps output byte-identical to baseline.
  let trailing: SurvivabilityReport | null = null;
  if (sf012Flags().survival) {
    const loaded = loadSurvivabilityConfig();
    const ledger = readFateLedger();
    trailing = computeSurvivability(ledger.records, loaded.config, ledger.torn_lines);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(trailing === null ? metrics : { ...metrics, trailing_quality: trailing }, null, 2));
  } else {
    console.log(trailing === null ? renderReport(metrics) : renderReport(metrics) + renderTrailingQuality(trailing));
  }
  process.exit(0);
}
