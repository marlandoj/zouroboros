#!/usr/bin/env bun

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";

const DEFAULT_ROSTER = "/home/workspace/packages/bench/data/zourobench/lineup-model-roster.json";
const DEFAULT_DATASET = "/home/workspace/packages/bench/data/zourobench/seed.json";
const DEFAULT_OUTPUT = "/home/workspace/packages/bench/data/staging/lineup-models";
const ADAPTER = "/home/workspace/packages/bench/adapters/zourobench-adapter.ts";
export const LINEUP_BENCHMARK_SEEDS = [101, 202, 303, 404, 505] as const;

export interface RosterModel {
  canonicalModel: string;
  benchmarkRoute: string;
  roles: string[];
  profiles: string[];
  priority: number;
  benchmarkEligible: boolean;
  benchmarkRunnable: boolean;
  benchmarkStatus: "qualified" | "missing" | "unsupported-role" | "held-route";
}

interface Roster {
  schemaVersion: number;
  benchmarkPolicy: { minimumReplicates: number };
  models: RosterModel[];
}

export interface ExistingReplicate {
  cohortId: string;
  model: string;
  index: number;
}

const FULL_ZOUROBENCH_QUESTION_COUNT = 45;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function evidencedString(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && nonEmptyString((value as { value?: unknown }).value));
}

export function parseExistingReplicateArtifact(raw: unknown): ExistingReplicate | null {
  if (!raw || typeof raw !== "object") return null;
  const artifact = raw as {
    schema_version?: unknown;
    run?: { run_id?: unknown; benchmark?: unknown; timestamp?: unknown };
    cohort?: { cohort_id?: unknown; replicate_index?: unknown; replicate_seed?: unknown; minimum_n?: unknown };
    execution?: {
      answer_model?: unknown;
      judge_model?: unknown;
      embedding_model?: unknown;
      max_tokens?: unknown;
      truncation_guard_enabled?: unknown;
    };
    totals?: { total_questions?: unknown; answered?: unknown };
    scores?: { overall_accuracy?: unknown };
    provenance?: { dataset_sha256?: unknown; question_set_sha256?: unknown; adapter_version?: unknown };
  };
  const index = artifact.cohort?.replicate_index;
  const score = artifact.scores?.overall_accuracy;
  if (
    artifact.schema_version !== 2
    || artifact.run?.benchmark !== "ZouroBench"
    || !nonEmptyString(artifact.run.run_id)
    || !nonEmptyString(artifact.run.timestamp)
    || !Number.isFinite(Date.parse(artifact.run.timestamp))
    || !nonEmptyString(artifact.cohort?.cohort_id)
    || !nonEmptyString(artifact.execution?.answer_model)
    || !Number.isInteger(index)
    || typeof index !== "number"
    || index < 1
    || index > LINEUP_BENCHMARK_SEEDS.length
    || artifact.cohort?.replicate_seed !== LINEUP_BENCHMARK_SEEDS[index - 1]
    || artifact.cohort?.minimum_n !== LINEUP_BENCHMARK_SEEDS.length
    || artifact.totals?.total_questions !== FULL_ZOUROBENCH_QUESTION_COUNT
    || artifact.totals?.answered !== FULL_ZOUROBENCH_QUESTION_COUNT
    || typeof score !== "number"
    || !Number.isFinite(score)
    || score < 0
    || score > 100
    || !nonEmptyString(artifact.provenance?.dataset_sha256)
    || !nonEmptyString(artifact.provenance?.question_set_sha256)
    || !nonEmptyString(artifact.provenance?.adapter_version)
    || !evidencedString(artifact.execution?.judge_model)
    || !evidencedString(artifact.execution?.embedding_model)
    || typeof artifact.execution?.max_tokens !== "number"
    || typeof artifact.execution?.truncation_guard_enabled !== "boolean"
  ) return null;
  return {
    cohortId: artifact.cohort.cohort_id,
    model: artifact.execution.answer_model,
    index,
  };
}

export interface LineupBenchmarkPlanItem {
  canonicalModel: string;
  benchmarkRoute: string;
  profiles: string[];
  roles: string[];
  priority: number;
  cohortId: string;
  completedReplicates: number[];
  nextReplicate: number | null;
  state: "qualified" | "queued" | "in-progress" | "blocked-complete-unqualified" | "unsupported-role" | "held-route";
}

export type LineupBenchmarkProvider = "zo-byok" | "kimi" | "synthetic" | "opencode" | "openrouter" | "openai";

export interface ProviderAwareBatchOptions {
  maxReplicates: number;
  concurrency: number;
  providerConcurrency: number;
}

export function providerForBenchmarkRoute(route: string): LineupBenchmarkProvider {
  if (route.startsWith("byok:")) return "zo-byok";
  if (route.startsWith("kimi:")) return "kimi";
  if (route.startsWith("hf:") || route.startsWith("syn:")) return "synthetic";
  if (route.startsWith("oc:")) return "opencode";
  if (route.startsWith("or:")) return "openrouter";
  return "openai";
}

export function buildProviderAwareWaves(
  runnable: LineupBenchmarkPlanItem[],
  options: ProviderAwareBatchOptions,
): LineupBenchmarkPlanItem[][] {
  const pending = [...runnable];
  const waves: LineupBenchmarkPlanItem[][] = [];
  let scheduled = 0;

  while (pending.length && scheduled < options.maxReplicates) {
    const wave: LineupBenchmarkPlanItem[] = [];
    const providerCounts = new Map<LineupBenchmarkProvider, number>();
    for (let index = 0; index < pending.length && wave.length < options.concurrency;) {
      const item = pending[index]!;
      const provider = providerForBenchmarkRoute(item.benchmarkRoute);
      const providerCount = providerCounts.get(provider) ?? 0;
      if (providerCount >= options.providerConcurrency) {
        index += 1;
        continue;
      }
      wave.push(item);
      providerCounts.set(provider, providerCount + 1);
      pending.splice(index, 1);
      scheduled += 1;
      if (scheduled >= options.maxReplicates) break;
    }
    if (!wave.length) break;
    waves.push(wave);
  }

  return waves;
}

export async function runProviderAwareWaves(
  waves: LineupBenchmarkPlanItem[][],
  executor: (item: LineupBenchmarkPlanItem) => Promise<void>,
): Promise<void> {
  for (const wave of waves) {
    const results = await Promise.allSettled(wave.map(executor));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${wave[index]!.canonicalModel}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : []);
    if (failures.length) {
      throw new Error(`lineup benchmark wave failed; later waves were not started: ${failures.join("; ")}`);
    }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "model";
}

export function cohortIdFor(model: Pick<RosterModel, "canonicalModel" | "benchmarkRoute">): string {
  const routeHash = createHash("sha256").update(model.benchmarkRoute).digest("hex").slice(0, 8);
  return `lineup-v1-${slug(model.canonicalModel)}-${routeHash}`;
}

export function buildLineupBenchmarkPlan(
  roster: Roster,
  existing: ExistingReplicate[] = [],
): LineupBenchmarkPlanItem[] {
  if (roster.schemaVersion !== 1) throw new Error(`unsupported roster schemaVersion=${roster.schemaVersion}`);
  if (roster.benchmarkPolicy.minimumReplicates !== LINEUP_BENCHMARK_SEEDS.length) {
    throw new Error(`roster minimumReplicates must be ${LINEUP_BENCHMARK_SEEDS.length}`);
  }
  return roster.models.map((model): LineupBenchmarkPlanItem => {
    const cohortId = cohortIdFor(model);
    const completedReplicates = [...new Set(existing
      .filter((replicate) => replicate.cohortId === cohortId && replicate.model === model.benchmarkRoute)
      .map((replicate) => replicate.index)
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= LINEUP_BENCHMARK_SEEDS.length))]
      .sort((a, b) => a - b);
    if (!model.benchmarkEligible || model.benchmarkStatus === "unsupported-role") {
      return { ...model, cohortId, completedReplicates, nextReplicate: null, state: "unsupported-role" };
    }
    if (!model.benchmarkRunnable || model.benchmarkStatus === "held-route") {
      return { ...model, cohortId, completedReplicates, nextReplicate: null, state: "held-route" };
    }
    if (model.benchmarkStatus === "qualified") {
      return { ...model, cohortId, completedReplicates, nextReplicate: null, state: "qualified" };
    }
    if (completedReplicates.length >= LINEUP_BENCHMARK_SEEDS.length) {
      return { ...model, cohortId, completedReplicates, nextReplicate: null, state: "blocked-complete-unqualified" };
    }
    const nextReplicate = LINEUP_BENCHMARK_SEEDS.findIndex((_, offset) => !completedReplicates.includes(offset + 1)) + 1;
    return {
      ...model,
      cohortId,
      completedReplicates,
      nextReplicate,
      state: completedReplicates.length ? "in-progress" : "queued",
    };
  }).sort((a, b) =>
    a.priority - b.priority
    || Number(a.state === "qualified") - Number(b.state === "qualified")
    || a.canonicalModel.localeCompare(b.canonicalModel)
  );
}

function listJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(absolute);
    }
  }
  return files;
}

function loadExistingReplicates(root: string): ExistingReplicate[] {
  const replicates: ExistingReplicate[] = [];
  for (const file of listJsonFiles(root)) {
    try {
      const replicate = parseExistingReplicateArtifact(JSON.parse(fs.readFileSync(file, "utf-8")));
      if (replicate) replicates.push(replicate);
    } catch {}
  }
  return replicates;
}

function loadRoster(file: string): Roster {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Roster;
  if (!Array.isArray(parsed.models) || !parsed.benchmarkPolicy) throw new Error("invalid lineup roster");
  return parsed;
}

async function runReplicate(
  item: LineupBenchmarkPlanItem,
  options: { dataset: string; output: string; limit: number; dryRun: boolean },
): Promise<void> {
  if (!item.nextReplicate) throw new Error(`${item.canonicalModel} has no runnable replicate`);
  const replicateSeed = LINEUP_BENCHMARK_SEEDS[item.nextReplicate - 1]!;
  const output = path.join(options.output, slug(item.canonicalModel));
  const args = [
    "bun",
    ADAPTER,
    "--dataset", options.dataset,
    "--output", output,
    "--limit", String(options.limit),
    "--judge",
    "--judge-model", "gpt-4o",
    "--runs", "1",
    "--replicate-seeds", String(replicateSeed),
    "--replicate-start", String(item.nextReplicate),
    "--cohort-runs", String(LINEUP_BENCHMARK_SEEDS.length),
    "--cohort-replicate-seeds", LINEUP_BENCHMARK_SEEDS.join(","),
    "--minimum-n", String(LINEUP_BENCHMARK_SEEDS.length),
    "--cohort-id", item.cohortId,
  ];
  if (options.dryRun) {
    console.log(JSON.stringify({ model: item.benchmarkRoute, replicate: item.nextReplicate, args }, null, 2));
    return;
  }
  fs.mkdirSync(output, { recursive: true });
  const child = Bun.spawn({
    cmd: args,
    cwd: "/home/workspace/packages/bench",
    env: { ...process.env, ZO_ANSWER_MODEL: item.benchmarkRoute },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${item.canonicalModel} replicate ${item.nextReplicate} failed with exit ${exitCode}`);
}

function printPlan(plan: LineupBenchmarkPlanItem[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      summary: {
        models: plan.length,
        qualified: plan.filter((item) => item.state === "qualified").length,
        runnable: plan.filter((item) => item.nextReplicate !== null).length,
        unsupportedRole: plan.filter((item) => item.state === "unsupported-role").length,
        heldRoute: plan.filter((item) => item.state === "held-route").length,
        blocked: plan.filter((item) => item.state === "blocked-complete-unqualified").length,
      },
      models: plan,
    }, null, 2));
    return;
  }
  for (const item of plan) {
    console.log(`${item.state.padEnd(30)} ${item.canonicalModel.padEnd(28)} ${item.benchmarkRoute}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      roster: { type: "string", default: DEFAULT_ROSTER },
      dataset: { type: "string", default: DEFAULT_DATASET },
      output: { type: "string", default: DEFAULT_OUTPUT },
      model: { type: "string", multiple: true },
      "max-replicates": { type: "string", default: "1" },
      concurrency: { type: "string", default: "2" },
      "provider-concurrency": { type: "string", default: "1" },
      limit: { type: "string", default: "15" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? "plan";
  if (values.help || !["plan", "run"].includes(command)) {
    console.log(`ZouroBench lineup model runner\n\nUsage:\n  bun scripts/lineup-model-bench.ts plan --json\n  bun scripts/lineup-model-bench.ts run --max-replicates 4 --concurrency 2 --provider-concurrency 1\n  bun scripts/lineup-model-bench.ts run --model glm-5.2\n  bun scripts/lineup-model-bench.ts run --dry-run`);
    if (!values.help) process.exitCode = 1;
    return;
  }
  const maxReplicates = Number(values["max-replicates"]);
  const concurrency = Number(values.concurrency);
  const providerConcurrency = Number(values["provider-concurrency"]);
  const limit = Number(values.limit);
  if (!Number.isInteger(maxReplicates) || maxReplicates < 1) throw new Error("--max-replicates must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("--concurrency must be an integer from 1 to 4");
  }
  if (!Number.isInteger(providerConcurrency) || providerConcurrency < 1 || providerConcurrency > 2) {
    throw new Error("--provider-concurrency must be an integer from 1 to 2");
  }
  if (providerConcurrency > concurrency) {
    throw new Error("--provider-concurrency must not exceed --concurrency");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 15) throw new Error("--limit must be an integer from 1 to 15");
  const roster = loadRoster(values.roster!);
  const plan = buildLineupBenchmarkPlan(roster, loadExistingReplicates(values.output!));
  if (command === "plan") {
    printPlan(plan, values.json!);
    return;
  }
  const blocked = plan.filter((item) => item.state === "blocked-complete-unqualified");
  if (blocked.length) {
    throw new Error(`completed cohort(s) remain unqualified: ${blocked.map((item) => item.canonicalModel).join(", ")}`);
  }
  const requestedModels = values.model ?? [];
  const runnable = plan.filter((item) => item.nextReplicate !== null && (
    !requestedModels.length
    || requestedModels.includes(item.canonicalModel)
    || requestedModels.includes(item.benchmarkRoute)
  ));
  if (requestedModels.length && !runnable.length) {
    throw new Error(`requested model(s) are unknown or not runnable: ${requestedModels.join(", ")}`);
  }
  const waves = buildProviderAwareWaves(runnable, { maxReplicates, concurrency, providerConcurrency });
  if (!waves.length) {
    console.log("No runnable lineup benchmark replicates.");
    return;
  }
  console.log(JSON.stringify({
    scheduledReplicates: waves.flat().length,
    waves: waves.map((wave) => wave.map((item) => ({
      model: item.canonicalModel,
      provider: providerForBenchmarkRoute(item.benchmarkRoute),
      replicate: item.nextReplicate,
    }))),
  }, null, 2));
  await runProviderAwareWaves(waves, (item) => runReplicate(item, {
      dataset: values.dataset!,
      output: values.output!,
      limit,
      dryRun: values["dry-run"]!,
    }));
}

if (import.meta.main) await main();
