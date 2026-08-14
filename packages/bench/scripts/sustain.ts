#!/usr/bin/env bun
/**
 * Sustain Benchmark — Q2 #5 §3.9 family (b) Cycle B
 *
 * Hybrid runner: --mode=synthetic compresses 24h into seconds via mocked clock
 * for CI; --mode=wall-clock issues real /zo/ask calls at the configured cadence
 * for the configured duration. Reuses Cycle A scoring helpers.
 *
 * Reports per-tier rolling p95 latency and drift (last-hour pass rate vs
 * first-hour pass rate). Run fails if total failure rate exceeds budget OR
 * any tier's drift falls below -driftThreshold.
 *
 * Usage:
 *   bun packages/bench/scripts/sustain.ts                                  # synthetic, 24h compressed
 *   bun packages/bench/scripts/sustain.ts --mode=wall-clock                # 24h real, 1/5min
 *   bun packages/bench/scripts/sustain.ts --mode=wall-clock --duration 3600 --cadence 60
 *
 * Env: ZO_CLIENT_IDENTITY_TOKEN (required for wall-clock mode).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { askModel, keywordOverlap, passesGate, type Tier } from "./fallback-fidelity";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEED_PATH = resolve(ROOT, "data/sustain/seed.json");
const RUNS_DIR = resolve(ROOT, "data/runs");

export type Mode = "synthetic" | "wall-clock";

export interface Rung { model: string; label: string; tier: Tier }
export interface Task {
  id: string;
  prompt: string;
  expectedKeywords: string[];
  minLength: number;
}
export interface SustainSeed {
  metadata: { name: string; version: string; description: string; purpose: string };
  defaults: {
    mode: Mode;
    cadenceSeconds: number;
    durationSeconds: number;
    failureBudget: number;
    driftThreshold: number;
    syntheticTickMs: number;
  };
  chain: { primary: string; primaryLabel: string; rungs: Rung[] };
  tasks: Task[];
}

export interface SustainCall {
  tickSeconds: number;
  taskId: string;
  rungLabel: string;
  tier: Tier;
  ok: boolean;
  latencyMs: number;
  passesGate: boolean;
  error?: string;
}

export interface TierSustainStats {
  tier: Tier;
  total: number;
  passes: number;
  passRate: number;
  failureRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  firstHourPassRate: number;
  lastHourPassRate: number;
  drift: number;
}

// ─── Pure helpers (unit-testable, no I/O) ─────────────────────────────

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

export function tierStats(
  calls: SustainCall[],
  tier: Tier,
  durationSeconds: number,
): TierSustainStats {
  const subset = calls.filter((c) => c.tier === tier);
  const total = subset.length;
  const passes = subset.filter((c) => c.passesGate).length;
  const passRate = total === 0 ? 0 : passes / total;
  const failureRate = total === 0 ? 0 : subset.filter((c) => !c.ok).length / total;
  const lats = subset.map((c) => c.latencyMs);
  const p50 = percentile(lats, 0.5);
  const p95 = percentile(lats, 0.95);

  const oneHour = 3600;
  const firstHourSubset = subset.filter((c) => c.tickSeconds < oneHour);
  const lastHourStart = Math.max(0, durationSeconds - oneHour);
  const lastHourSubset = subset.filter((c) => c.tickSeconds >= lastHourStart);
  const firstHourPassRate =
    firstHourSubset.length === 0 ? 0 : firstHourSubset.filter((c) => c.passesGate).length / firstHourSubset.length;
  const lastHourPassRate =
    lastHourSubset.length === 0 ? 0 : lastHourSubset.filter((c) => c.passesGate).length / lastHourSubset.length;
  // Drift is only meaningful when both windows have observations; otherwise
  // emit 0 (no signal) so the gate doesn't fire on sparse data.
  const drift = firstHourSubset.length === 0 || lastHourSubset.length === 0 ? 0 : lastHourPassRate - firstHourPassRate;

  return { tier, total, passes, passRate, failureRate, p50LatencyMs: p50, p95LatencyMs: p95, firstHourPassRate, lastHourPassRate, drift };
}

export function evaluateRun(
  calls: SustainCall[],
  durationSeconds: number,
  failureBudget: number,
  driftThreshold: number,
): { tiers: TierSustainStats[]; overallFailureRate: number; budgetOk: boolean; driftOk: boolean; pass: boolean } {
  const tiers: Tier[] = ["proprietary", "open-weight", "zo-native"];
  const tierResults = tiers.map((t) => tierStats(calls, t, durationSeconds));
  const totalCalls = calls.length;
  const failedCalls = calls.filter((c) => !c.ok).length;
  const overallFailureRate = totalCalls === 0 ? 0 : failedCalls / totalCalls;
  const budgetOk = overallFailureRate <= failureBudget;
  const driftOk = tierResults.every((t) => t.total === 0 || t.drift >= -driftThreshold);
  return { tiers: tierResults, overallFailureRate, budgetOk, driftOk, pass: budgetOk && driftOk };
}

// ─── Synthetic dispatcher (pure, no live calls) ────────────────────────

export interface SyntheticOptions {
  baselinePassRate?: number;
  driftPerHour?: number;
  baselineLatencyMs?: number;
  failureRate?: number;
  rngSeed?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticDispatch(
  seed: SustainSeed,
  durationSeconds: number,
  cadenceSeconds: number,
  opts: SyntheticOptions = {},
): SustainCall[] {
  const baselinePass = opts.baselinePassRate ?? 0.95;
  // Default drift represents a healthy chain — a real failing chain would set
  // driftPerHour <= -0.01 (see test "synthesized run with steep drift fails…").
  const driftPerHour = opts.driftPerHour ?? -0.001;
  const baseLat = opts.baselineLatencyMs ?? 1500;
  const failRate = opts.failureRate ?? 0.01;
  const rng = mulberry32(opts.rngSeed ?? 42);

  const calls: SustainCall[] = [];
  for (let t = 0; t < durationSeconds; t += cadenceSeconds) {
    const taskIdx = Math.floor((t / cadenceSeconds) % seed.tasks.length);
    const task = seed.tasks[taskIdx];
    for (const rung of seed.chain.rungs) {
      const hours = t / 3600;
      const passProb = Math.max(0, Math.min(1, baselinePass + driftPerHour * hours));
      const r = rng();
      const ok = r > failRate;
      const passesGate = ok && rng() < passProb;
      const tierLatencyMul = rung.tier === "open-weight" ? 0.7 : rung.tier === "zo-native" ? 0.6 : 1;
      const latency = Math.round(baseLat * tierLatencyMul * (0.7 + rng() * 0.6));
      calls.push({
        tickSeconds: t,
        taskId: task.id,
        rungLabel: rung.label,
        tier: rung.tier,
        ok,
        latencyMs: latency,
        passesGate,
        error: ok ? undefined : "synthetic-injected-failure",
      });
    }
  }
  return calls;
}

// ─── Wall-clock dispatcher (real /zo/ask calls) ───────────────────────

async function wallClockDispatch(
  seed: SustainSeed,
  durationSeconds: number,
  cadenceSeconds: number,
  onCall?: (c: SustainCall) => void,
): Promise<SustainCall[]> {
  const calls: SustainCall[] = [];
  const startMs = Date.now();
  let tickIdx = 0;
  while (true) {
    const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
    if (elapsedSec >= durationSeconds) break;
    const taskIdx = tickIdx % seed.tasks.length;
    const task = seed.tasks[taskIdx];
    for (const rung of seed.chain.rungs) {
      const r = await askModel(rung.model, task.prompt);
      const call: SustainCall = {
        tickSeconds: elapsedSec,
        taskId: task.id,
        rungLabel: rung.label,
        tier: rung.tier,
        ok: r.ok,
        latencyMs: r.latencyMs,
        passesGate: r.ok ? passesGate(r.output, task) : false,
        error: r.error,
      };
      calls.push(call);
      onCall?.(call);
    }
    tickIdx++;
    const nextTickMs = startMs + tickIdx * cadenceSeconds * 1000;
    const sleepMs = nextTickMs - Date.now();
    if (sleepMs > 0) await new Promise((res) => setTimeout(res, sleepMs));
  }
  return calls;
}

// ─── CLI ──────────────────────────────────────────────────────────────

interface CliArgs { mode: Mode; cadence?: number; duration?: number }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { mode: "synthetic" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode" || a.startsWith("--mode=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      if (v !== "synthetic" && v !== "wall-clock") throw new Error(`bad mode: ${v}`);
      out.mode = v;
    } else if (a === "--cadence") out.cadence = parseInt(argv[++i], 10);
    else if (a === "--duration") out.duration = parseInt(argv[++i], 10);
  }
  return out;
}

function formatStats(s: TierSustainStats): string {
  if (s.total === 0) return `  ${s.tier.padEnd(12)} (no calls)`;
  const drift = (s.drift * 100).toFixed(1) + "%";
  const passPct = (s.passRate * 100).toFixed(0);
  const failPct = (s.failureRate * 100).toFixed(1);
  return `  ${s.tier.padEnd(12)} pass=${passPct}% fail=${failPct}% p50=${s.p50LatencyMs}ms p95=${s.p95LatencyMs}ms drift=${drift}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf-8")) as SustainSeed;
  const cadence = args.cadence ?? seed.defaults.cadenceSeconds;
  const duration = args.duration ?? seed.defaults.durationSeconds;

  console.log(`sustain → ${seed.metadata.name} v${seed.metadata.version}`);
  console.log(`  mode: ${args.mode}`);
  console.log(`  cadence: 1 dispatch / ${cadence}s`);
  console.log(`  duration: ${duration}s (${(duration / 3600).toFixed(2)}h)`);
  console.log(`  chain: ${seed.chain.primaryLabel} (${seed.chain.rungs.length} rungs)`);
  console.log(`  budget: ${(seed.defaults.failureBudget * 100).toFixed(0)}% failures`);
  console.log(`  drift threshold: ${(seed.defaults.driftThreshold * 100).toFixed(0)}%`);
  console.log();

  let calls: SustainCall[];
  if (args.mode === "synthetic") {
    calls = syntheticDispatch(seed, duration, cadence);
    console.log(`Synthetic dispatch complete: ${calls.length} simulated calls.`);
  } else {
    console.log("Wall-clock dispatch starting (Ctrl-C to abort early)...");
    calls = await wallClockDispatch(seed, duration, cadence, (c) => {
      const flag = c.ok && c.passesGate ? "✓" : c.ok ? "·" : "✗";
      console.log(`  [t=${c.tickSeconds}s] ${flag} ${c.taskId} @ ${c.rungLabel} (${c.latencyMs}ms)`);
    });
  }

  const result = evaluateRun(calls, duration, seed.defaults.failureBudget, seed.defaults.driftThreshold);

  console.log();
  console.log("Per-tier results:");
  for (const t of result.tiers) console.log(formatStats(t));
  console.log();
  console.log(`Overall failure rate: ${(result.overallFailureRate * 100).toFixed(2)}% (budget ${(seed.defaults.failureBudget * 100).toFixed(0)}%) → ${result.budgetOk ? "OK" : "EXCEEDED"}`);
  console.log(`Drift gate: ${result.driftOk ? "OK" : "REGRESSION"}`);
  console.log();
  console.log(result.pass ? "OVERALL: PASS" : "OVERALL: FAIL");

  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(RUNS_DIR, `sustain-${args.mode}-${ts}.json`);
  writeFileSync(
    out,
    JSON.stringify({ seed: seed.metadata, mode: args.mode, cadence, duration, runAt: new Date().toISOString(), result, calls }, null, 2),
  );
  console.log(`\nWrote ${out}`);
  process.exit(result.pass ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => { console.error("FATAL:", err); process.exit(2); });
}
