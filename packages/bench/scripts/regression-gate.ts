#!/usr/bin/env bun
/**
 * ZOU-401: Eval-Driven CI/CD Gate
 *
 * Runs ZouroBench, diffs against baseline, emits PASS/FAIL/WARN.
 * Exit codes: 0=PASS, 1=FAIL(>2% regression), 2=WARN(between 1-2%), 3=ERROR
 *
 * Usage:
 *   bun regression-gate.ts                  # Full 54-question run
 *   bun regression-gate.ts --quick          # 15-question sanity check
 *   bun regression-gate.ts --baseline-only  # Just update baseline, don't gate
 *   bun regression-gate.ts --update-baseline # Force-accept this run as the new floor
 *
 * Baseline promotion: only a clean PASS (or --baseline-only / --update-baseline)
 * updates the saved baseline. FAIL and WARN runs leave the prior baseline intact
 * so a regression cannot silently ratchet the accepted floor downward.
 *
 * A baseline category that is absent from the current run is treated as a
 * regression (an entire dimension vanished), not silently skipped — pass
 * --update-baseline to deliberately accept a category removal.
 *
 * Corrupt/unreadable baseline or run files exit with ERROR (3), never FAIL (1),
 * so CI never mistakes an IO/parse failure for a quality regression.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const BENCH_DIR = "/home/workspace/zouroboros/packages/bench";
const RUNS_DIR = join(BENCH_DIR, "data", "runs");
const BASELINE_DIR = join(BENCH_DIR, "data", "baselines");
const ADAPTER = join(BENCH_DIR, "adapters", "zourobench-adapter.ts");
const SEED = join(BENCH_DIR, "data", "zourobench", "seed.json");
const PROJECT_ROOT = join(BENCH_DIR, "..", "..");
const REPLAY_GATE = join(BENCH_DIR, "scripts", "replay-regression.ts");
const REGRESSION_THRESHOLD = 0.02;   // 2% — anything worse triggers FAIL
const WARN_THRESHOLD = 0.01;         // 1% — triggers WARN

interface GateResult {
  overall: number;
  categories: Record<string, number>;
  // ... details omitted for brevity
}

/**
 * ZOU-403: read + parse a JSON file, throwing a descriptive error on any IO or
 * parse failure. Kept pure (throws rather than exits) so it is unit-testable.
 */
export function readJsonFile(path: string): any {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`unable to read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

/**
 * ZOU-403: load a JSON file, translating any IO/parse failure into the
 * documented ERROR exit code (3) so CI never misreads a corrupt or
 * partially-written file as a regression (exit 1).
 */
function loadJsonOrExit(path: string, label: string): any {
  try {
    return readJsonFile(path);
  } catch (err) {
    console.error(`ERROR: failed to load ${label}: ${(err as Error).message}`);
    process.exit(3);
  }
}

function loadBaseline(): { timestamp: string; scores: Record<string,number> } | null {
  const dir = join(BENCH_DIR, "data", "baselines");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort().reverse();
  if (!files.length) return null;
  return loadJsonOrExit(join(dir, files[0]), "baseline");
}

function loadLatestRun(): any | null {
  if (!existsSync(RUNS_DIR)) return null;
  const files = readdirSync(RUNS_DIR).filter(f => f.startsWith("ZouroBench") && f.endsWith(".json")).sort().reverse();
  if (!files.length) return null;
  return loadJsonOrExit(join(RUNS_DIR, files[0]), "latest run");
}

export function computeDiff(current: Record<string,number>, baseline: Record<string,number>): { regressions: string[]; improvements: string[]; unchanged: string[]; worstRegression: number } {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const unchanged: string[] = [];
  let worstRegression = 0;

  for (const [key, baseScore] of Object.entries(baseline)) {
    const currScore = current[key];
    if (currScore === undefined) {
      // ZOU-404: a baseline category absent from the current run is a silent
      // regression — an entire measured dimension vanished (e.g. it failed to
      // score). Treat the full baseline score as lost so the gate FAILs; an
      // operator must pass --update-baseline to deliberately accept a removal.
      regressions.push(`${key}: ${(baseScore*100).toFixed(1)}% → MISSING (category absent from current run)`);
      worstRegression = Math.max(worstRegression, baseScore);
      continue;
    }
    const diff = baseScore - currScore;
    if (diff > REGRESSION_THRESHOLD) {
      regressions.push(`${key}: ${(baseScore*100).toFixed(1)}% → ${(currScore*100).toFixed(1)}% (Δ${(diff*100).toFixed(1)}%)`);
      worstRegression = Math.max(worstRegression, diff);
    } else if (diff > WARN_THRESHOLD) {
      unchanged.push(`${key}: ${(baseScore*100).toFixed(1)}% → ${(currScore*100).toFixed(1)}% (Δ${(diff*100).toFixed(1)}%) ⚠️`);
    } else if (diff < -0.01) {
      improvements.push(`${key}: ${(baseScore*100).toFixed(1)}% → ${(currScore*100).toFixed(1)}% (+${(-diff*100).toFixed(1)}%)`);
    } else {
      unchanged.push(`${key}: ${(baseScore*100).toFixed(1)}% → ${(currScore*100).toFixed(1)}% (stable)`);
    }
  }
  return { regressions, improvements, unchanged, worstRegression };
}

function saveBaseline(run: any) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, "-");
  const catScores: Record<string,number> = {};
  if (run.scores?.by_category) {
    for (const [key, value] of Object.entries(run.scores.by_category as Record<string, {accuracy?: number}>)) {
      if (value?.accuracy !== undefined) catScores[key] = value.accuracy / 100;
    }
  }
  const baseline = {
    timestamp: ts,
    scores: {
      overall: (run.scores?.overall_accuracy ?? 0) / 100,
      ...catScores,
    },
    run_file: run.timestamp || "unknown",
  };
  writeFileSync(join(BASELINE_DIR, `baseline-${ts}.json`), JSON.stringify(baseline, null, 2));
  console.log(`Baseline saved to data/baselines/baseline-${ts}.json`);
  console.log(`  Overall: ${(baseline.scores.overall * 100).toFixed(1)}%`);
}

export type GateStatus = "bootstrap" | "pass" | "warn" | "fail";

/**
 * Decide whether a run is allowed to become the new baseline.
 * A failing or warning run must NOT silently ratchet the baseline downward —
 * only a clean PASS (or an explicit operator override) promotes the floor.
 */
export function shouldUpdateBaseline(
  status: GateStatus,
  opts: { updateBaseline?: boolean; baselineOnly?: boolean } = {}
): boolean {
  if (opts.updateBaseline || opts.baselineOnly) return true; // explicit operator override
  if (status === "bootstrap") return true;                   // first run must establish a floor
  return status === "pass";                                  // regressions/drift never promote
}

async function main() {
  const args = process.argv.slice(2);
  const isQuick = args.includes("--quick");
  const baselineOnly = args.includes("--baseline-only");
  const updateBaseline = args.includes("--update-baseline");
  let replayRegression = false;

  console.log("╔══════════════════════════════════════╗");
  console.log("║  ZOU-401: Eval-Driven CI/CD Gate     ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Step 1: Run the benchmark (unless baseline-only)
  if (!baselineOnly) {
    console.log("Running ZouroBench...");
    const cmdArgs = ["run", ADAPTER, "--dataset", SEED, "--judge"];
    if (isQuick) cmdArgs.push("--limit", "15");
    
    const result = spawnSync("bun", cmdArgs, {
      cwd: BENCH_DIR,
      timeout: 300_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    if (result.status !== 0) {
      console.error(`Benchmark failed (exit ${result.status}):\n${result.stderr?.slice(0, 500)}`);
      process.exit(3);
    }
    console.log(result.stdout?.split("\n").filter(l => l.includes("accuracy") || l.includes("✓") || l.includes("✗")).join("\n") || "Benchmark completed");

    const replay = spawnSync("bun", [REPLAY_GATE, "--target", "zourobench", "--root", PROJECT_ROOT], {
      cwd: BENCH_DIR,
      timeout: 120_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (replay.status !== 0 && replay.status !== 1) {
      console.error(`Replay regression gate errored (exit ${replay.status}):\n${replay.stderr?.slice(0, 500)}`);
      process.exit(3);
    }
    replayRegression = replay.status === 1;
    console.log(replay.stdout?.trim() || "Replay regression completed");
  }

  // Step 2: Load results
  const run = loadLatestRun();
  if (!run) {
    console.error("No benchmark run found");
    process.exit(3);
  }

  const currentScores: Record<string,number> = {
    overall: run.scores?.overall_accuracy ? run.scores.overall_accuracy / 100 : 0,
  };
  if (run.scores?.by_category) {
    for (const [key, value] of Object.entries(run.scores.by_category as Record<string, {accuracy?: number}>)) {
      if (value?.accuracy !== undefined) {
        currentScores[key] = value.accuracy / 100;
      }
    }
  }

  // Step 3: Load baseline and diff
  const baseline = loadBaseline();

  if (!baseline || baselineOnly) {
    if (replayRegression && !baselineOnly) {
      console.log("\n🚫 GATE: FAIL — deterministic replay corpus contains failures");
      process.exit(1);
    }
    if (shouldUpdateBaseline("bootstrap", { updateBaseline, baselineOnly })) saveBaseline(run);
    console.log("\n✅ Baseline established — no gate decision");
    process.exit(0);
  }

  console.log(`\nBaseline: ${baseline.timestamp}`);
  console.log(`  Baseline overall: ${(baseline.scores.overall * 100).toFixed(1)}%`);
  console.log(`  Current overall:  ${(currentScores.overall * 100).toFixed(1)}%\n`);

  // Step 4: Compute diff
  const diff = computeDiff(currentScores, baseline.scores);

  if (diff.regressions.length > 0) {
    console.log("❌ REGRESSIONS (>2%):");
    diff.regressions.forEach(r => console.log(`  ${r}`));
  }

  if (diff.improvements.length > 0) {
    console.log("\n📈 IMPROVEMENTS (>1%):");
    diff.improvements.forEach(i => console.log(`  ${i}`));
  }

  if (diff.unchanged.length > 0) {
    console.log("\n➖ STABLE / MINOR:");
    diff.unchanged.forEach(u => console.log(`  ${u}`));
  }

  // Step 5: Gate decision
  console.log("\n────────────────────────────────────────");
  let status: GateStatus;
  let exitCode: number;
  if (diff.regressions.length > 0 || replayRegression) {
    console.log("🚫 GATE: FAIL — Regressions detected");
    console.log(`  Worst regression: ${(diff.worstRegression * 100).toFixed(1)}%`);
    if (replayRegression) console.log("  Deterministic replay corpus contains failures");
    status = "fail";
    exitCode = 1;
  } else if (diff.unchanged.some(u => u.includes("⚠️"))) {
    console.log("⚠️  GATE: WARN — Minor drift detected (<2%)");
    status = "warn";
    exitCode = 2;
  } else {
    console.log("✅ GATE: PASS — No regressions");
    status = "pass";
    exitCode = 0;
  }

  // A failing/warning run must not silently become the new floor.
  if (shouldUpdateBaseline(status, { updateBaseline, baselineOnly })) {
    saveBaseline(run);
  } else {
    console.log("ℹ️  Baseline NOT updated — this run did not pass; the prior baseline stands.");
    console.log("   Re-run with --update-baseline to deliberately accept this run as the new floor.");
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  // ZOU-403: an unhandled rejection would otherwise surface as a non-zero exit
  // that overlaps the documented FAIL code (1). Route it to ERROR (3) instead.
  main().catch((err) => {
    console.error(`ERROR: regression gate crashed: ${err?.stack ?? err}`);
    process.exit(3);
  });
}
