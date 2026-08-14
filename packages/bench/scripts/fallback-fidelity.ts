#!/usr/bin/env bun
/**
 * Fallback Fidelity Benchmark — Q2 #5 §3.9 family (b)
 *
 * For each task in the seed corpus, invokes every rung of the target fallback
 * chain (proprietary → open-weight → zo-native) via /zo/ask and scores output
 * against tier-specific gates. Per-tier pass-rate must clear the configured
 * threshold; a chain whose open-weight rung produces unusable output is a
 * resilience gap.
 *
 * Usage:
 *   bun packages/bench/scripts/fallback-fidelity.ts
 *   bun packages/bench/scripts/fallback-fidelity.ts --dry-run     # skip live calls
 *   bun packages/bench/scripts/fallback-fidelity.ts --tasks 2     # subset
 *
 * Env: ZO_CLIENT_IDENTITY_TOKEN (required for live runs).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEED_PATH = resolve(ROOT, "data/fallback-fidelity/seed.json");
const RUNS_DIR = resolve(ROOT, "data/runs");

const ZO_ASK_API = process.env.ZO_ASK_API || "https://api.zo.computer/zo/ask";
const TIMEOUT_MS = 120_000;

export type Tier = "proprietary" | "open-weight" | "zo-native";

export interface Rung { model: string; label: string; tier: Tier }
export interface Task {
  id: string;
  prompt: string;
  expectedKeywords: string[];
  minLength: number;
}
export interface Seed {
  metadata: { name: string; version: string; description: string; purpose: string };
  chain: { primary: string; primaryLabel: string; rungs: Rung[] };
  tierThresholds: Record<Tier, number>;
  tasks: Task[];
}

export interface CallResult {
  taskId: string;
  model: string;
  label: string;
  tier: Tier;
  ok: boolean;
  latencyMs: number;
  outputLength: number;
  keywordOverlap: number;
  passesGate: boolean;
  error?: string;
}

// ─── Scoring (pure, unit-testable) ────────────────────────────────────

export function keywordOverlap(output: string, keywords: string[]): number {
  if (keywords.length === 0) return 1;
  const lower = output.toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (lower.includes(kw.toLowerCase())) hits++;
  return hits / keywords.length;
}

export function passesGate(
  output: string,
  task: Pick<Task, "expectedKeywords" | "minLength">,
  overlapFloor = 0.4,
): boolean {
  if (output.length < task.minLength) return false;
  return keywordOverlap(output, task.expectedKeywords) >= overlapFloor;
}

export interface TierStats { tier: Tier; passes: number; total: number; rate: number; threshold: number; meetsThreshold: boolean }

export function aggregateByTier(
  results: CallResult[],
  thresholds: Record<Tier, number>,
): TierStats[] {
  const tiers: Tier[] = ["proprietary", "open-weight", "zo-native"];
  return tiers.map((tier) => {
    const subset = results.filter((r) => r.tier === tier);
    const passes = subset.filter((r) => r.passesGate).length;
    const total = subset.length;
    const rate = total === 0 ? 0 : passes / total;
    const threshold = thresholds[tier];
    return { tier, passes, total, rate, threshold, meetsThreshold: total === 0 || rate >= threshold };
  });
}

// ─── Live calls ────────────────────────────────────────────────────────

export async function askModel(model: string, prompt: string): Promise<{ ok: boolean; output: string; latencyMs: number; error?: string }> {
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set");
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(ZO_ASK_API, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ input: prompt, model_name: model }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return { ok: false, output: "", latencyMs, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    }
    const data = (await resp.json()) as { output?: string };
    const output = (data.output || "").toString();
    return { ok: true, output, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return { ok: false, output: "", latencyMs, error: err?.name === "AbortError" ? `timeout(${TIMEOUT_MS}ms)` : err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runTaskAtRung(task: Task, rung: Rung): Promise<CallResult> {
  const r = await askModel(rung.model, task.prompt);
  return {
    taskId: task.id,
    model: rung.model,
    label: rung.label,
    tier: rung.tier,
    ok: r.ok,
    latencyMs: r.latencyMs,
    outputLength: r.output.length,
    keywordOverlap: r.ok ? keywordOverlap(r.output, task.expectedKeywords) : 0,
    passesGate: r.ok ? passesGate(r.output, task) : false,
    error: r.error,
  };
}

// ─── Runner ────────────────────────────────────────────────────────────

interface CliArgs { dryRun: boolean; tasksLimit?: number }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--tasks") out.tasksLimit = parseInt(argv[++i], 10);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf-8")) as Seed;
  const tasks = args.tasksLimit ? seed.tasks.slice(0, args.tasksLimit) : seed.tasks;
  const total = tasks.length * seed.chain.rungs.length;

  console.log(`fallback-fidelity → ${seed.metadata.name} v${seed.metadata.version}`);
  console.log(`  chain: ${seed.chain.primaryLabel} (${seed.chain.rungs.length} rungs)`);
  console.log(`  tasks: ${tasks.length}, total calls: ${total}`);
  console.log(`  mode: ${args.dryRun ? "DRY RUN (no live calls)" : "LIVE"}`);
  console.log();

  if (args.dryRun) {
    console.log("Dry run complete — seed valid, would issue", total, "calls.");
    return;
  }

  const results: CallResult[] = [];
  let i = 0;
  for (const task of tasks) {
    for (const rung of seed.chain.rungs) {
      i++;
      process.stdout.write(`  [${i}/${total}] ${task.id} @ ${rung.label}... `);
      const r = await runTaskAtRung(task, rung);
      results.push(r);
      if (r.ok && r.passesGate) console.log(`PASS (${r.latencyMs}ms, kw=${r.keywordOverlap.toFixed(2)}, len=${r.outputLength})`);
      else if (r.ok) console.log(`FAIL_GATE (${r.latencyMs}ms, kw=${r.keywordOverlap.toFixed(2)}, len=${r.outputLength})`);
      else console.log(`ERROR (${r.error?.slice(0, 80)})`);
    }
  }

  const tierStats = aggregateByTier(results, seed.tierThresholds);
  const allTiersPass = tierStats.every((t) => t.meetsThreshold);

  console.log();
  console.log("Tier results:");
  for (const t of tierStats) {
    const flag = t.meetsThreshold ? "✓" : "✗";
    console.log(`  ${flag} ${t.tier.padEnd(12)} ${t.passes}/${t.total} (${(t.rate * 100).toFixed(0)}%) — threshold ${(t.threshold * 100).toFixed(0)}%`);
  }
  console.log();
  console.log(allTiersPass ? "OVERALL: PASS — every tier clears its threshold." : "OVERALL: FAIL — at least one tier below threshold.");

  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(RUNS_DIR, `fallback-fidelity-${ts}.json`);
  writeFileSync(out, JSON.stringify({ seed: seed.metadata, runAt: new Date().toISOString(), tierStats, results }, null, 2));
  console.log(`\nWrote ${out}`);

  process.exit(allTiersPass ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => { console.error("FATAL:", err); process.exit(2); });
}
