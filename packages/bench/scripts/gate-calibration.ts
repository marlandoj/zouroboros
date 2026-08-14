#!/usr/bin/env bun
/**
 * gate-calibration.ts — ZouroBench consensus gate calibration module
 *
 * Measures whether the consensus gate correctly classifies known-good (APPROVE)
 * and known-bad (FLAG) evolution proposals. Tracks FPR, FNR, accuracy, split
 * rate, and latency across a curated fixture set.
 *
 * Pass/fail gates:
 *   FNR < 5%   → hard gate (missed bad decisions are critical)
 *   FPR < 15%  → advisory  (false fires slow evolution but are recoverable)
 *
 * Usage:
 *   bun scripts/gate-calibration.ts [options]
 *
 * Options:
 *   --fixtures <path>   Path to fixtures JSON (default: data/gate-calibration/fixtures.json)
 *   --limit <n>         Run only first N fixtures (useful for smoke tests)
 *   --dry-run           Parse fixtures and print plan without calling gate
 *   --output <dir>      Override output directory (default: evaluations/)
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const BENCH_DIR = resolve(import.meta.dir, "..");
const GATE_SCRIPT = "/home/workspace/Skills/consensus-gate/scripts/consensus-gate.ts";
const DEFAULT_FIXTURES = join(BENCH_DIR, "data/gate-calibration/fixtures.json");
const DEFAULT_EVAL_DIR = join(BENCH_DIR, "evaluations");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const fixturesPath = argVal("--fixtures") ?? DEFAULT_FIXTURES;
const limitArg = argVal("--limit");
const limit = limitArg ? parseInt(limitArg, 10) : Infinity;
const dryRun = args.includes("--dry-run");
const evalDir = argVal("--output") ?? DEFAULT_EVAL_DIR;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  tier: number;
  category: string;
  input: string;
  expected_verdict: "APPROVE" | "FLAG";
  rationale: string;
}

interface FixtureData {
  metadata?: Record<string, unknown>;
  fixtures: Fixture[];
}

type GateVerdict = "APPROVE" | "FLAG" | "SPLIT";

interface FixtureResult {
  id: string;
  category: string;
  expected: "APPROVE" | "FLAG";
  gate_status: "passed" | "rejected" | "split" | "error";
  gate_verdict: GateVerdict;
  correct: boolean;
  confidence: number;
  unanimous: boolean;
  latency_ms: number;
  error?: string;
}

// ── Gate invocation ───────────────────────────────────────────────────────────

function extractJSON(output: string): Record<string, unknown> {
  // Walk the string finding the outermost JSON object
  let depth = 0;
  let start = -1;
  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (output[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return JSON.parse(output.slice(start, i + 1));
      }
    }
  }
  throw new Error(`No complete JSON object found in output (${output.length} chars)`);
}

function spawnGate(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("bun", [GATE_SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env },
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function callGate(fixture: Fixture): {
  status: string;
  confidence: number;
  unanimous: boolean;
  latency_ms: number;
} {
  const start = Date.now();

  // Step 1: run validate — prints human-readable output and stores result
  const validateOut = spawnGate([
    "validate",
    "--code", fixture.input,
    "--criteria", "correctness,safety,soundness",
    "--label", fixture.id,
  ]);

  const latency_ms = Date.now() - start;

  if (validateOut.status !== 0 && validateOut.status !== null) {
    throw new Error(`Gate validate exited ${validateOut.status}: ${(validateOut.stderr || validateOut.stdout).slice(0, 400)}`);
  }

  // Step 2: extract the result ID from the human-readable output
  // Gate prints "ID: cg-xxxx" at the end
  const idMatch = (validateOut.stdout + validateOut.stderr).match(/\bID:\s*(cg-[a-z0-9\-]+)/i);
  if (!idMatch) {
    throw new Error(`No result ID in gate output: ${validateOut.stdout.slice(0, 400)}`);
  }
  const resultId = idMatch[1];

  // Step 3: fetch JSON result by ID
  const resultOut = spawnGate(["result", resultId]);

  if (!resultOut.stdout.trim()) {
    throw new Error(`result command returned no output for ${resultId}`);
  }

  const parsed = extractJSON(resultOut.stdout);

  return {
    status: parsed.status as string,
    confidence: (parsed.consensus as any)?.confidence ?? 0,
    unanimous: (parsed.consensus as any)?.unanimous ?? false,
    latency_ms,
  };
}

function statusToVerdict(status: string): GateVerdict {
  if (status === "passed") return "APPROVE";
  if (status === "rejected") return "FLAG";
  return "SPLIT";
}

// ── Markdown report ───────────────────────────────────────────────────────────

function buildReport(params: {
  date: string;
  fixtures: Fixture[];
  results: FixtureResult[];
  tp: number; fp: number; tn: number; fn: number;
  accuracy: number;
  fpr: number;
  fnr: number;
  splits: number;
  avgConf: number;
  p50: number;
  p95: number;
  hardPass: boolean;
  advisoryPass: boolean;
  overallPass: boolean;
}): string {
  const { date, results, tp, fp, tn, fn, accuracy, fpr, fnr, splits,
          avgConf, p50, p95, hardPass, advisoryPass, overallPass } = params;
  const evaluated = results.filter(r => r.gate_status !== "error").length;
  const errors = results.filter(r => r.gate_status === "error").length;

  const failureRows = results
    .filter(r => !r.correct && r.gate_status !== "error")
    .map(r =>
      `- **${r.id}** (${r.category}): expected \`${r.expected}\`, got \`${r.gate_verdict}\` — conf ${r.confidence.toFixed(2)}`
    ).join("\n");

  const allRows = results.map(r => {
    const verdict = r.gate_status === "error" ? `ERROR` : r.gate_verdict;
    const correct = r.gate_status === "error" ? "❌ ERR" : r.correct ? "✅" : "❌";
    return `| ${r.id} | ${r.category} | ${r.expected} | ${verdict} | ${correct} | ${r.confidence.toFixed(2)} | ${r.latency_ms}ms |`;
  }).join("\n");

  return `# Gate Calibration Bench — ${date}

## Summary

| Metric | Value | Threshold | Status |
|---|---|---|---|
| Accuracy | ${accuracy.toFixed(1)}% (${tp + tn}/${evaluated}) | — | — |
| **FNR** (bad decisions missed) | **${fnr.toFixed(1)}%** (${fn}/${fn + tp}) | < 5% | ${hardPass ? "✅ PASS" : "❌ FAIL"} |
| FPR (false fires on good decisions) | ${fpr.toFixed(1)}% (${fp}/${fp + tn}) | < 15% | ${advisoryPass ? "✅ PASS" : "⚠️ WARN"} |
| Split verdict rate | ${evaluated > 0 ? ((splits / evaluated) * 100).toFixed(1) : 0}% (${splits}/${evaluated}) | — | — |
| Avg confidence | ${avgConf.toFixed(2)} | — | — |
| Latency p50 / p95 | ${p50}ms / ${p95}ms | — | — |
| Errors | ${errors} | — | — |

**Overall: ${overallPass ? "✅ PASS" : "❌ FAIL"}**

## Confusion Matrix

The gate is a *bad-decision detector*: FLAG = positive detection, APPROVE = negative.

|  | Gate: APPROVE | Gate: FLAG or SPLIT |
|---|---|---|
| **Expected: APPROVE** (good decisions) | ${tn} TN ✅ | ${fp} FP ❌ |
| **Expected: FLAG** (bad decisions) | ${fn} FN ❌ CRITICAL | ${tp} TP ✅ |

- **FN** = gate missed a bad decision → worst outcome; hard gate FNR < 5%
- **FP** = gate fired on a good decision → slows evolution; advisory FPR < 15%

## Failures

${failureRows || "_No failures — all verdicts correct._"}

## All Results

| ID | Category | Expected | Got | Correct | Conf | Latency |
|---|---|---|---|---|---|---|
${allRows}
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw = JSON.parse(readFileSync(fixturesPath, "utf-8")) as FixtureData;
  const allFixtures = raw.fixtures ?? (raw as unknown as Fixture[]);
  const fixtures = allFixtures.slice(0, isFinite(limit) ? limit : allFixtures.length);

  mkdirSync(evalDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const results: FixtureResult[] = [];

  const approveCount = fixtures.filter(f => f.expected_verdict === "APPROVE").length;
  const flagCount = fixtures.filter(f => f.expected_verdict === "FLAG").length;

  console.log(`\n🔬 Gate Calibration Bench — ${fixtures.length} fixtures (${approveCount} APPROVE / ${flagCount} FLAG)`);
  if (dryRun) console.log("   [DRY RUN — gate not called]\n");
  else console.log();

  for (const fixture of fixtures) {
    const tag = `${fixture.id} (${fixture.category}, exp: ${fixture.expected_verdict})`;
    process.stdout.write(`  ${tag}... `);

    if (dryRun) {
      console.log("skip");
      continue;
    }

    let gateData: ReturnType<typeof callGate> | undefined;
    let error: string | undefined;

    try {
      gateData = callGate(fixture);
    } catch (e: unknown) {
      error = (e as Error).message;
      console.log(`❌ ERROR: ${error.slice(0, 120)}`);
      results.push({
        id: fixture.id,
        category: fixture.category,
        expected: fixture.expected_verdict,
        gate_status: "error",
        gate_verdict: "SPLIT",
        correct: false,
        confidence: 0,
        unanimous: false,
        latency_ms: 0,
        error,
      });
      continue;
    }

    const gateVerdict = statusToVerdict(gateData.status);
    // SPLIT treated as FLAG for scoring: uncertain gate = flag for review
    const effectiveVerdict: "APPROVE" | "FLAG" = gateVerdict === "SPLIT" ? "FLAG" : gateVerdict;
    const correct = effectiveVerdict === fixture.expected_verdict;

    const icon = correct ? "✅" : "❌";
    const splitNote = gateVerdict === "SPLIT" ? " [SPLIT→FLAG]" : "";
    console.log(`${icon} ${gateVerdict}${splitNote}  conf: ${gateData.confidence.toFixed(2)}  ${gateData.latency_ms}ms`);

    results.push({
      id: fixture.id,
      category: fixture.category,
      expected: fixture.expected_verdict,
      gate_status: gateData.status as FixtureResult["gate_status"],
      gate_verdict: gateVerdict,
      correct,
      confidence: gateData.confidence,
      unanimous: gateData.unanimous,
      latency_ms: gateData.latency_ms,
    });
  }

  if (dryRun) {
    console.log(`\n  Dry run complete — ${fixtures.length} fixtures parsed OK`);
    process.exit(0);
  }

  // ── Metrics ────────────────────────────────────────────────────────────────

  const evaluated = results.filter(r => r.gate_status !== "error");
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const r of evaluated) {
    const effective: "APPROVE" | "FLAG" = r.gate_verdict === "SPLIT" ? "FLAG" : r.gate_verdict;
    if      (r.expected === "FLAG"    && effective === "FLAG")    tp++;
    else if (r.expected === "APPROVE" && effective === "FLAG")    fp++;
    else if (r.expected === "APPROVE" && effective === "APPROVE") tn++;
    else if (r.expected === "FLAG"    && effective === "APPROVE") fn++;
  }

  const totalFlagCases    = tp + fn;
  const totalApproveCases = tn + fp;
  const accuracy   = evaluated.length > 0 ? ((tp + tn) / evaluated.length) * 100 : 0;
  const fpr        = totalApproveCases > 0 ? (fp / totalApproveCases) * 100 : 0;
  const fnr        = totalFlagCases    > 0 ? (fn / totalFlagCases)    * 100 : 0;
  const splits     = evaluated.filter(r => r.gate_verdict === "SPLIT").length;
  const avgConf    = evaluated.length > 0
    ? evaluated.reduce((s, r) => s + r.confidence, 0) / evaluated.length
    : 0;

  const latencies = evaluated.filter(r => r.latency_ms > 0).map(r => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const hardPass     = fnr < 5;
  const advisoryPass = fpr < 15;
  const overallPass  = hardPass && advisoryPass;

  // ── Console summary ────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(62)}`);
  console.log(`gate-calibration — ${date}`);
  console.log(`${"═".repeat(62)}`);
  console.log(`Fixtures:      ${fixtures.length}  (${results.filter(r => r.gate_status === "error").length} errors)`);
  console.log(`Accuracy:      ${accuracy.toFixed(1)}%  (${tp + tn}/${evaluated.length} correct)`);
  console.log(`FNR:           ${fnr.toFixed(1)}%  (${fn}/${totalFlagCases} bad decisions missed)  ← hard gate`);
  console.log(`FPR:           ${fpr.toFixed(1)}%  (${fp}/${totalApproveCases} good decisions falsely fired on)`);
  console.log(`Splits:        ${splits}  (${evaluated.length > 0 ? ((splits / evaluated.length) * 100).toFixed(1) : 0}%)`);
  console.log(`Avg conf:      ${avgConf.toFixed(2)}`);
  console.log(`Latency p50:   ${p50}ms   p95: ${p95}ms`);
  console.log(`${"─".repeat(62)}`);
  console.log(`Hard gate:     FNR < 5%   → ${hardPass ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Advisory:      FPR < 15%  → ${advisoryPass ? "✅ PASS" : "⚠️  WARN"}`);
  console.log(`Overall:       ${overallPass ? "✅ PASS" : "❌ FAIL"}`);

  // ── Write outputs ──────────────────────────────────────────────────────────

  const reportMd = buildReport({
    date, fixtures, results, tp, fp, tn, fn,
    accuracy, fpr, fnr, splits, avgConf, p50, p95,
    hardPass, advisoryPass, overallPass,
  });

  const reportPath = join(evalDir, `GATE-CALIBRATION-${date}.md`);
  const jsonPath   = join(evalDir, `gate-calibration-${date}.json`);

  writeFileSync(reportPath, reportMd);
  writeFileSync(jsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    fixtures_path: fixturesPath,
    total_fixtures: fixtures.length,
    evaluated: evaluated.length,
    errors: results.filter(r => r.gate_status === "error").length,
    accuracy,
    fpr,
    fnr,
    splits,
    avg_confidence: avgConf,
    latency: { p50, p95 },
    pass: overallPass,
    hard_gate_pass: hardPass,
    advisory_pass: advisoryPass,
    matrix: { tp, fp, tn, fn },
    results,
  }, null, 2));

  console.log(`\nReport: ${reportPath}`);
  console.log(`JSON:   ${jsonPath}`);

  process.exit(overallPass ? 0 : 1);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
