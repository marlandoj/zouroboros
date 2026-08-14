#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import {
  NoopCodingRunner,
  ProductionCodingRunner,
  ReferenceCodingRunner,
  loadCodingManifest,
  runCodingFold,
  runCodingTask,
  writeCodingArtifact,
} from "../coding/runner";
import { manifestFingerprint } from "../coding/contracts";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

function help(): void {
  console.log(`ZouroBench Code (shadow only)

Usage:
  bun scripts/zourobench-code.ts validate
  bun scripts/zourobench-code.ts preflight --executor reference|codex|opencode|gemini --task <task-id> [--model <model>] [--provider <provider>]
  bun scripts/zourobench-code.ts run --executor reference|noop --fold 1
  bun scripts/zourobench-code.ts run --executor codex|opencode|gemini --model <model> --fold 1 [--provider <provider>]

Options:
  --manifest <path>       Corpus manifest
  --output <directory>    Artifact directory
  --task <task-id>        Run one bounded task without publishing cohort evidence
  --keep-workdir          Preserve disposable task repositories
  --allow-task-failures   Exit zero after writing an artifact with task failures
`);
}

const command = process.argv[2];
if (!command || command === "--help" || command === "help") {
  help();
  process.exit(0);
}

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    manifest: { type: "string" },
    output: { type: "string" },
    executor: { type: "string" },
    model: { type: "string" },
    provider: { type: "string" },
    fold: { type: "string" },
    task: { type: "string" },
    "keep-workdir": { type: "boolean", default: false },
    "allow-task-failures": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

const manifest = loadCodingManifest(values.manifest);
if (command === "validate") {
  console.log(JSON.stringify({
    valid: true,
    benchmark: manifest.benchmark,
    corpusVersion: manifest.corpusVersion,
    tasks: manifest.tasks.length,
    folds: [...new Set(manifest.tasks.map((task) => task.fold))].length,
    manifestSha256: manifestFingerprint(manifest),
  }, null, 2));
  process.exit(0);
}

if (command !== "run" && command !== "preflight") throw new Error(`unknown command: ${command}`);
const executor = values.executor;
if (!executor) throw new Error("--executor is required");

const runner = executor === "reference"
  ? new ReferenceCodingRunner()
  : executor === "noop"
    ? new NoopCodingRunner()
    : new ProductionCodingRunner(executor, values.model ?? (() => { throw new Error("--model is required for a production executor"); })(), values.provider);

if (command === "preflight") {
  const taskId = values.task;
  if (!taskId) throw new Error("--task is required for preflight");
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown coding task: ${taskId}`);
  const result = await runCodingTask(task, runner, values["keep-workdir"]);
  console.log(JSON.stringify({
    task: result.taskId,
    model: runner.model,
    executor: runner.executor,
    status: result.status,
    executorSuccess: result.executorSuccess,
    durationMs: result.durationMs,
    error: result.error,
    patchFiles: result.patch.filesChanged,
    score: result.scores.overall,
    shadowOnly: true,
    cohortEvidenceWritten: false,
  }, null, 2));
  if (!result.executorSuccess || result.patch.filesChanged.length === 0) process.exitCode = 1;
} else {
  const fold = Number(values.fold);
  if (!Number.isInteger(fold) || fold < 1 || fold > 5) throw new Error("--fold must be an integer from 1 through 5");

  const artifact = await runCodingFold({
    manifest,
    fold,
    runner,
    keepWorkdir: values["keep-workdir"],
  });
  const outputDir = values.output ?? join(PACKAGE_ROOT, "data", "staging", "zourobench-code");
  const file = writeCodingArtifact(artifact, outputDir);
  console.log(JSON.stringify({
    file,
    model: artifact.execution.model,
    executor: artifact.execution.executor,
    fold: artifact.cohort.fold_index,
    passed: artifact.totals.passed,
    tasks: artifact.totals.tasks,
    score: artifact.scores.overall,
    shadowOnly: true,
  }, null, 2));
  if (artifact.totals.failed > 0 && !values["allow-task-failures"]) process.exitCode = 1;
}
