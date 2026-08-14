import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  CODE_BENCHMARK_HARNESS_VERSION,
  type CodingCheckResult,
  type CodingCorpusManifest,
  type CodingFoldArtifactV1,
  type CodingPatchEvidence,
  type CodingTaskManifest,
  type CodingTaskResult,
  averageTaskScores,
  manifestFingerprint,
  sha256,
  validateCodingManifest,
} from "./contracts";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const RUN_ROOT = join(WORKSPACE_ROOT, ".zourobench-code-runs");
const REGISTRY_PATH = join(WORKSPACE_ROOT, "packages", "swarm", "src", "executor", "registry", "executor-registry.json");
const BWRAP_ADAPTER = join(import.meta.dir, "bwrap-acp.sh");
const TSC_CLI = join(WORKSPACE_ROOT, "node_modules", "typescript", "bin", "tsc");
const SWARM_CLIENT_MODULE = "../../swarm/src/client/executor-client";

interface ProductionExecutorClient {
  run(prompt: string, options: {
    workdir: string;
    timeoutMs: number;
    idleTimeoutMs: number;
    ragMinScore: number;
    env: Record<string, string>;
  }): Promise<{ success: boolean; output: string; raw: { error?: string } }>;
  dispose(): Promise<void>;
}

async function loadProductionExecutorClient(executor: string, registryPath: string): Promise<ProductionExecutorClient> {
  const module = await import(SWARM_CLIENT_MODULE) as {
    ExecutorClient: { for(id: string, options: { registryPath: string }): Promise<ProductionExecutorClient> };
  };
  return module.ExecutorClient.for(executor, { registryPath });
}

export interface AgentRunContext {
  task: CodingTaskManifest;
  workdir: string;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

export interface CodingAgentRunner {
  executor: string;
  model: string;
  sandbox: "bubblewrap" | "fixture";
  run(context: AgentRunContext): Promise<AgentRunResult>;
  dispose?(): Promise<void>;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function loadCodingManifest(path = join(PACKAGE_ROOT, "data", "zourobench-code", "manifest.json")): CodingCorpusManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as CodingCorpusManifest;
  const errors = validateCodingManifest(manifest);
  if (errors.length) throw new Error(`invalid ZouroBench Code manifest:\n${errors.join("\n")}`);
  return manifest;
}

function absoluteCorpusPath(relativePath: string): string {
  const absolute = resolve(PACKAGE_ROOT, relativePath);
  const root = join(PACKAGE_ROOT, "data", "zourobench-code", ".corpus");
  if (absolute !== root && !absolute.startsWith(`${root}/`)) throw new Error(`corpus path escapes root: ${relativePath}`);
  return absolute;
}

export function resolveProcessCommand(command: string[]): string[] {
  return command[0] === "tsc" ? [process.execPath, TSC_CLI, ...command.slice(1)] : command;
}

async function runProcess(command: string[], cwd: string, timeoutMs = 120_000): Promise<ProcessResult> {
  const resolved = resolveProcessCommand(command);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const process = Bun.spawn(resolved, {
      cwd,
      env: { ...processEnv(), NO_COLOR: "1", FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const stdoutPromise = new Response(process.stdout).text();
    const stderrPromise = new Response(process.stderr).text();
    const exitCode = await process.exited;
    return {
      exitCode,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      exitCode: 124,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function check(id: string, kind: CodingCheckResult["kind"], command: string[], cwd: string): Promise<CodingCheckResult> {
  const result = await runProcess(command, cwd);
  return {
    id,
    kind,
    command,
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    durationMs: result.durationMs,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
}

async function initializeRepository(task: CodingTaskManifest): Promise<string> {
  mkdirSync(RUN_ROOT, { recursive: true });
  const workdir = mkdtempSync(join(RUN_ROOT, `${task.id}-`));
  cpSync(absoluteCorpusPath(task.starterDir), workdir, { recursive: true });
  for (const command of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "zourobench-code@localhost"],
    ["git", "config", "user.name", "ZouroBench Code"],
    ["git", "add", "."],
    ["git", "commit", "-q", "-m", "fixture baseline"],
  ]) {
    const result = await runProcess(command, workdir);
    if (result.exitCode !== 0) throw new Error(`fixture git initialization failed: ${command.join(" ")}: ${result.stderr}`);
  }
  return workdir;
}

async function capturePatch(task: CodingTaskManifest, workdir: string): Promise<CodingPatchEvidence> {
  await runProcess(["git", "add", "-N", "."], workdir);
  const [names, stats, diff] = await Promise.all([
    runProcess(["git", "diff", "--name-only"], workdir),
    runProcess(["git", "diff", "--numstat"], workdir),
    runProcess(["git", "diff", "--binary"], workdir),
  ]);
  const filesChanged = names.stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
  let linesAdded = 0;
  let linesDeleted = 0;
  const binaryFiles = new Set<string>();
  for (const line of stats.stdout.split("\n").filter(Boolean)) {
    const [added, deleted, file] = line.split("\t");
    if (added === "-" || deleted === "-") binaryFiles.add(file ?? "unknown");
    else {
      linesAdded += Number(added) || 0;
      linesDeleted += Number(deleted) || 0;
    }
  }
  const forbiddenFiles = filesChanged.filter((file) =>
    binaryFiles.has(file)
    || (!file.startsWith("src/") && !file.startsWith("test/"))
    || (task.category === "test-creation" && file.startsWith("src/"))
  );
  return { filesChanged, linesAdded, linesDeleted, diffSha256: sha256(diff.stdout), forbiddenFiles };
}

async function mutationCheck(task: CodingTaskManifest, workdir: string): Promise<CodingCheckResult> {
  const target = join(workdir, task.targetFile);
  const candidate = readFileSync(target);
  const mutation = readFileSync(absoluteCorpusPath(task.mutationFile));
  writeFileSync(target, mutation);
  const result = await runProcess(task.requiredCommands[1]!, workdir);
  writeFileSync(target, candidate);
  return {
    id: "candidate-tests-reject-mutation",
    kind: "mutation",
    command: task.requiredCommands[1]!,
    exitCode: result.exitCode,
    passed: result.exitCode !== 0,
    durationMs: result.durationMs,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
}

function scoreTask(task: CodingTaskManifest, agent: AgentRunResult, checks: CodingCheckResult[], patch: CodingPatchEvidence): CodingTaskResult["scores"] {
  if (!agent.success) {
    return { correctness: 0, regressionSafety: 0, patchScope: 0, testQuality: 0, efficiency: 0, overall: 0 };
  }
  const required = checks.filter((item) => item.kind === "required");
  const hidden = checks.filter((item) => item.kind === "hidden");
  const mutation = checks.find((item) => item.kind === "mutation");
  const correctness = hidden.length ? 60 * hidden.filter((item) => item.passed).length / hidden.length : 0;
  const regressionSafety = required.length ? 20 * required.filter((item) => item.passed).length / required.length : 0;
  const inScope = patch.forbiddenFiles.length === 0
    && patch.filesChanged.length <= task.maxChangedFiles
    && patch.linesAdded + patch.linesDeleted <= task.maxChangedLines;
  const patchScope = inScope ? 10 : 0;
  const testChanged = patch.filesChanged.some((file) => file.startsWith("test/"));
  const testQuality = testChanged && mutation?.passed ? 5 : 0;
  const efficiency = agent.success && agent.durationMs <= task.timeoutMs ? 5 : 0;
  return { correctness, regressionSafety, patchScope, testQuality, efficiency, overall: correctness + regressionSafety + patchScope + testQuality + efficiency };
}

export async function runCodingTask(task: CodingTaskManifest, runner: CodingAgentRunner, keepWorkdir = false): Promise<CodingTaskResult> {
  const workdir = await initializeRepository(task);
  let agent: AgentRunResult = { success: false, output: "", durationMs: 0, error: "agent did not run" };
  try {
    try {
      agent = await runner.run({ task, workdir });
    } catch (error) {
      agent = { success: false, output: "", durationMs: 0, error: error instanceof Error ? error.message : String(error) };
    }
    const patch = await capturePatch(task, workdir);
    const checks: CodingCheckResult[] = [];
    for (const [index, command] of task.requiredCommands.entries()) checks.push(await check(`required-${index + 1}`, "required", command, workdir));
    const hiddenDir = join(workdir, ".zbc-hidden");
    mkdirSync(hiddenDir, { recursive: true });
    const sourceHiddenDir = absoluteCorpusPath(task.hiddenChecksDir);
    for (let index = 0; index < task.hiddenCommands.length; index++) {
      cpSync(join(sourceHiddenDir, `check-${index + 1}.test.ts`), join(hiddenDir, `check-${index + 1}.test.ts`));
      checks.push(await check(`hidden-${index + 1}`, "hidden", task.hiddenCommands[index]!, workdir));
    }
    checks.push(await mutationCheck(task, workdir));
    const scores = scoreTask(task, agent, checks, patch);
    const requiredPass = checks.filter((item) => item.kind === "required").every((item) => item.passed);
    const hiddenPass = checks.filter((item) => item.kind === "hidden").every((item) => item.passed);
    const status = !agent.success ? "executor-error" : requiredPass && hiddenPass && scores.patchScope === 10 && scores.testQuality === 5 ? "pass" : "fail";
    return {
      taskId: task.id,
      category: task.category,
      status,
      executorSuccess: agent.success,
      executorOutputSha256: sha256(agent.output),
      durationMs: agent.durationMs,
      checks,
      patch,
      scores,
      error: agent.error ?? null,
    };
  } finally {
    if (!keepWorkdir) rmSync(workdir, { recursive: true, force: true });
  }
}

function gitProvenance(): { git_commit: string; git_dirty: boolean | null } {
  try {
    const git_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: WORKSPACE_ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages/bench", "Skills/consensus-gate"], { cwd: WORKSPACE_ROOT, encoding: "utf8" }).trim();
    return { git_commit, git_dirty: dirty.length > 0 };
  } catch {
    return { git_commit: "unavailable", git_dirty: null };
  }
}

export async function runCodingFold(input: {
  manifest: CodingCorpusManifest;
  fold: number;
  runner: CodingAgentRunner;
  keepWorkdir?: boolean;
  now?: () => Date;
}): Promise<CodingFoldArtifactV1> {
  const tasks = input.manifest.tasks.filter((task) => task.fold === input.fold);
  if (tasks.length !== 4) throw new Error(`fold ${input.fold} must contain four tasks`);
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const started = Date.now();
  const results: CodingTaskResult[] = [];
  try {
    for (const task of tasks) results.push(await runCodingTask(task, input.runner, input.keepWorkdir));
  } finally {
    await input.runner.dispose?.();
  }
  const completedAt = now().toISOString();
  const provenance = gitProvenance();
  return {
    schema_version: 1,
    run: {
      run_id: `zbc-${input.runner.model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-f${input.fold}-${Date.now().toString(36)}`,
      benchmark: "ZouroBench-Code",
      timestamp: completedAt,
      shadow_only: true,
    },
    cohort: {
      cohort_id: `zbc-v1-${input.runner.model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      fold_index: input.fold,
      fold_seed: tasks[0]!.seed,
      minimum_folds: 5,
    },
    provenance: {
      produced_by: "zourobench-code",
      harness_version: CODE_BENCHMARK_HARNESS_VERSION,
      corpus_version: input.manifest.corpusVersion,
      manifest_sha256: manifestFingerprint(input.manifest),
      ...provenance,
    },
    execution: {
      model: input.runner.model,
      executor: input.runner.executor,
      sandbox: input.runner.sandbox,
      timeout_ms: Math.max(...tasks.map((task) => task.timeoutMs)),
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Date.now() - started,
    },
    totals: {
      tasks: results.length,
      passed: results.filter((result) => result.status === "pass").length,
      failed: results.filter((result) => result.status !== "pass").length,
    },
    scores: averageTaskScores(results),
    tasks: results,
  };
}

export class ReferenceCodingRunner implements CodingAgentRunner {
  readonly executor = "fixture-reference";
  readonly model = "fixture:reference";
  readonly sandbox = "fixture" as const;
  async run({ task, workdir }: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now();
    cpSync(absoluteCorpusPath(task.solutionDir), workdir, { recursive: true, force: true });
    return { success: true, output: "reference solution applied", durationMs: Date.now() - started };
  }
}

export class NoopCodingRunner implements CodingAgentRunner {
  readonly executor = "fixture-noop";
  readonly model = "fixture:noop";
  readonly sandbox = "fixture" as const;
  async run(): Promise<AgentRunResult> {
    return { success: true, output: "no changes", durationMs: 0 };
  }
}

function sandboxRegistry(executor: string): { path: string; adapter: string } {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as { executors: Array<Record<string, unknown> & { id?: string; transport?: string; acp?: Record<string, unknown> }> };
  const entry = registry.executors.find((candidate) => candidate.id === executor);
  if (!entry || entry.transport !== "acp" || !entry.acp || typeof entry.acp.adapterBin !== "string") {
    throw new Error(`executor ${executor} is not a production ACP coder harness`);
  }
  const adapter = entry.acp.adapterBin;
  const isolated = structuredClone(entry);
  isolated.acp = { ...isolated.acp, adapterBin: BWRAP_ADAPTER, mcpConfig: undefined };
  const path = join("/tmp", `zbc-registry-${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ executors: [isolated] }));
  return { path, adapter };
}

export class ProductionCodingRunner implements CodingAgentRunner {
  readonly sandbox = "bubblewrap" as const;
  constructor(
    readonly executor: string,
    readonly model: string,
    private readonly provider?: string,
  ) {
    chmodSync(BWRAP_ADAPTER, 0o755);
  }

  async run({ task, workdir }: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now();
    const registry = sandboxRegistry(this.executor);
    const client = await loadProductionExecutorClient(this.executor, registry.path);
    const prompt = [
      "You are the coding executor for one isolated ZouroBench Code task.",
      "Work only in the current repository. Do not inspect parent directories or external workspace paths.",
      "Do not commit. Do not add dependencies. Preserve public APIs unless the task explicitly requires a type-safe refinement.",
      "Run the visible typecheck and tests before finishing.",
      "",
      `Task: ${task.title}`,
      task.prompt,
    ].join("\n");
    try {
      const result = await client.run(prompt, {
        workdir,
        timeoutMs: task.timeoutMs,
        idleTimeoutMs: Math.min(120_000, task.timeoutMs),
        ragMinScore: 1.1,
        env: {
          ZBC_WORKDIR: workdir,
          ZBC_ADAPTER_BIN: registry.adapter,
          SWARM_RESOLVED_MODEL: this.model,
          ...(this.provider ? { SWARM_PROVIDER: this.provider } : {}),
        },
      });
      return {
        success: result.success,
        output: result.output,
        durationMs: Date.now() - started,
        error: result.success ? undefined : result.raw.error,
      };
    } finally {
      await client.dispose();
      rmSync(registry.path, { force: true });
    }
  }
}

export function writeCodingArtifact(artifact: CodingFoldArtifactV1, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `ZouroBench-Code-${artifact.run.timestamp.replace(/[:.]/g, "-")}-f${artifact.cohort.fold_index}.json`);
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  return file;
}

export function runRootExists(): boolean {
  return existsSync(RUN_ROOT);
}
