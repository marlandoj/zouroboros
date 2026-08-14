#!/usr/bin/env bun
/**
 * autoloop.ts — Autonomous single-metric optimization loop
 *
 * Reads a program.md, creates a git branch, and loops:
 *   propose change → commit → run experiment → measure metric → keep or revert
 *
 * Inspired by karpathy/autoresearch. Generalized for any single-metric task.
 */

import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve, dirname, basename, join, relative, isAbsolute } from "path";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProgramConfig {
  name: string;
  objective: string;
  metric: {
    name: string;
    direction: "lower_is_better" | "higher_is_better";
    extract: string;
  };
  setup: string;
  targetFile: string;
  runCommand: string;
  readOnlyFiles: string[];
  constraints: {
    timeBudgetSeconds: number;
    maxExperiments: number;
    maxDurationHours: number;
    maxCostUSD: number;
  };
  stagnation: {
    threshold: number;
    doubleThreshold: number;
    tripleThreshold: number;
  };
  notes: string;
}

interface ExperimentRecord {
  commit: string;
  metric: number;
  status: "keep" | "discard" | "crash";
  description: string;
  timestamp: string;
  durationMs: number;
}

interface LoopState {
  bestMetric: number;
  bestCommit: string;
  experimentCount: number;
  stagnationCount: number;
  totalCostUSD: number;
  unreportedCostCalls: number;
  startTime: number;
  results: ExperimentRecord[];
  branch: string;
}

interface ProposalResult {
  hypothesis: string;
  costUSD: number;
  costReported: boolean;
}

// ---------------------------------------------------------------------------
// Parse program.md
// ---------------------------------------------------------------------------

export function parseProgram(path: string): ProgramConfig {
  const raw = readFileSync(path, "utf-8");

  const getSection = (heading: string): string => {
    const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
    const match = raw.match(re);
    if (!match || match.index === undefined) return "";
    const start = match.index + match[0].length;
    const nextHeading = raw.slice(start).search(/^##\s+/m);
    const end = nextHeading === -1 ? raw.length : start + nextHeading;
    return raw.slice(start, end).trim();
  };

  const getField = (section: string, field: string): string => {
    const re = new RegExp(`^-\\s+\\*\\*${field}\\*\\*:\\s*(.+)$`, "im");
    const match = section.match(re);
    return match ? match[1].trim() : "";
  };

  const nameMatch = raw.match(/^#\s+Program:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : "unnamed";

  const metricSection = getSection("Metric");
  const metricName = getField(metricSection, "name");
  const direction = getField(metricSection, "direction") as "lower_is_better" | "higher_is_better";
  // Accept both "extract" and "command" field names for compatibility with older prescriptions
  const extractRaw = getField(metricSection, "extract") || getField(metricSection, "command");
  const extract = extractRaw.replace(/^`|`$/g, "");

  const constraintsSection = getSection("Constraints");
  const parseConstraint = (label: string, fallback: number): number => {
    const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*([\\d.]+)`, "i");
    const m = constraintsSection.match(re);
    return m ? parseFloat(m[1]) : fallback;
  };

  const stagnationSection = getSection("Stagnation");
  const parseStagnation = (label: string, fallback: number): number => {
    const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*(\\d+)`, "i");
    const m = stagnationSection.match(re);
    return m ? parseInt(m[1]) : fallback;
  };

  const readOnlySection = getSection("Read-Only Files");
  const readOnlyFiles = readOnlySection
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);

  const setupSection = getSection("Setup");
  const setupCode = setupSection.match(/```(?:bash)?\n([\s\S]*?)```/);

  const runSection = getSection("Run Command");
  const runCode = runSection.match(/```(?:bash)?\n([\s\S]*?)```/);

  const targetFile = getSection("Target File").split("\n")[0].replace(/^`|`$/g, "").trim();

  return {
    name,
    objective: getSection("Objective"),
    metric: {
      name: metricName,
      direction: direction || "lower_is_better",
      extract,
    },
    setup: setupCode ? setupCode[1].trim() : setupSection,
    targetFile,
    runCommand: runCode ? runCode[1].trim() : runSection.split("\n")[0],
    readOnlyFiles,
    constraints: {
      timeBudgetSeconds: (() => {
        const re = /\*\*Time budget per run\*\*:\s*([\d.]+)\s*(seconds?|minutes?|hours?)?/i;
        const match = constraintsSection.match(re);
        if (!match) return 300;
        const value = parseFloat(match[1]);
        const unit = (match[2] || "seconds").toLowerCase();
        return value * (unit.startsWith("hour") ? 3600 : unit.startsWith("minute") ? 60 : 1);
      })(),
      maxExperiments: parseConstraint("Max experiments", 100),
      maxDurationHours: parseConstraint("Max duration", 8),
      maxCostUSD: parseConstraint("Max cost(?: \\(USD\\))?", 10),
    },
    stagnation: {
      threshold: parseStagnation("Threshold", 10),
      doubleThreshold: parseStagnation("Double threshold", 20),
      tripleThreshold: parseStagnation("Triple threshold", 30),
    },
    notes: getSection("Notes"),
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function gitShortHash(cwd: string): Promise<string> {
  return (await $`git rev-parse --short HEAD`.cwd(cwd).text()).trim();
}

async function gitResetLast(cwd: string): Promise<void> {
  await $`git reset --hard HEAD~1`.cwd(cwd).quiet();
}

async function gitCommit(cwd: string, file: string, message: string): Promise<string> {
  await $`git add ${file}`.cwd(cwd).quiet();
  await $`git commit -m ${message}`.cwd(cwd).quiet();
  return gitShortHash(cwd);
}

async function gitBranchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await $`git rev-parse --verify ${branch}`.cwd(cwd).quiet();
    return true;
  } catch {
    return false;
  }
}

export async function assertSafeGitState(workDir: string, targetFile: string): Promise<string> {
  const gitRoot = (await $`git rev-parse --show-toplevel`.cwd(workDir).text()).trim();
  const targetPath = resolve(workDir, targetFile);
  const targetFromRoot = relative(gitRoot, targetPath);
  if (!targetFromRoot || targetFromRoot.startsWith("..") || isAbsolute(targetFromRoot)) {
    throw new Error(`Target file must be inside the Git repository: ${targetPath}`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Target file not found: ${targetPath}`);
  }
  const status = (await $`git status --porcelain --untracked-files=no`.cwd(gitRoot).text()).trim();
  if (status) {
    throw new Error(`Tracked worktree is not clean. Run autoloop in an isolated clean worktree.\n${status}`);
  }
  const tracked = await $`git ls-files --error-unmatch ${targetFromRoot}`.cwd(gitRoot).quiet().nothrow();
  if (tracked.exitCode !== 0) {
    throw new Error(`Target file must be tracked before autoloop starts: ${targetFromRoot}`);
  }
  return gitRoot;
}

async function assertOnlyTargetChanged(workDir: string, targetFile: string): Promise<void> {
  const gitRoot = (await $`git rev-parse --show-toplevel`.cwd(workDir).text()).trim();
  const changed = (await $`git status --porcelain --untracked-files=no`.cwd(gitRoot).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const targetFromRoot = relative(gitRoot, resolve(workDir, targetFile));
  const unexpected = changed.filter((file) => file !== targetFromRoot);
  if (unexpected.length > 0) {
    throw new Error(`Executor modified files outside the target: ${unexpected.join(", ")}`);
  }
}

async function discardTargetChanges(workDir: string, targetFile: string): Promise<void> {
  await assertOnlyTargetChanged(workDir, targetFile);
  await $`git restore --staged --worktree -- ${targetFile}`.cwd(workDir).quiet().nothrow();
}

// ---------------------------------------------------------------------------
// Experiment execution
// ---------------------------------------------------------------------------

async function runExperiment(
  config: ProgramConfig,
  workDir: string
): Promise<{ metric: number; crashed: boolean; error?: string; durationMs: number }> {
  const timeoutSec = config.constraints.timeBudgetSeconds * 2; // 2x budget as hard kill
  const start = Date.now();

  try {
    // Write runCommand to a temp script to avoid Bun shell escaping issues with pipes/special chars
    const runScript = join(workDir, `.autoloop-run-${Date.now()}.sh`);
    writeFileSync(runScript, `#!/bin/bash\n${config.runCommand}\n`);
    const result = await $`timeout ${timeoutSec} bash ${runScript}`
      .cwd(workDir)
      .quiet()
      .nothrow();
    try { unlinkSync(runScript); } catch { /* ignore */ }

    const durationMs = Date.now() - start;

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().slice(0, 2000);
      return { metric: 0, crashed: true, error: stderr, durationMs };
    }

    // Extract metric — write to a temp script file to avoid Bun shell escaping issues
    // with pipes and special characters in the metric command.
    const metricScript = join(workDir, `.autoloop-metric-extract-${Date.now()}.sh`);
    writeFileSync(metricScript, `#!/bin/bash\n${config.metric.extract}\n`);
    const metricResult = await $`bash ${metricScript}`.cwd(workDir).quiet().nothrow();
    try { unlinkSync(metricScript); } catch { /* ignore */ }
    if (metricResult.exitCode !== 0) {
      return { metric: 0, crashed: true, error: `Metric extraction failed: ${metricResult.stderr.toString().slice(0, 500)}`, durationMs };
    }

    const metricValue = parseFloat(metricResult.stdout.toString().trim());
    if (isNaN(metricValue)) {
      return { metric: 0, crashed: true, error: `Metric not a number: "${metricResult.stdout.toString().trim()}"`, durationMs };
    }

    return { metric: metricValue, crashed: false, durationMs };
  } catch (err: any) {
    return { metric: 0, crashed: true, error: err.message?.slice(0, 2000), durationMs: Date.now() - start };
  }
}

function isBetter(current: number, best: number, direction: "lower_is_better" | "higher_is_better"): boolean {
  return direction === "lower_is_better" ? current < best : current > best;
}

// ---------------------------------------------------------------------------
// Agent interaction (proposal generation)
// ---------------------------------------------------------------------------

async function proposeChange(
  config: ProgramConfig,
  state: LoopState,
  workDir: string,
  executor: string
): Promise<ProposalResult> {
  const targetContent = readFileSync(resolve(workDir, config.targetFile), "utf-8");

  // Build context with last 20 results
  const recentResults = state.results.slice(-20);
  const historyBlock = recentResults.length > 0
    ? recentResults.map((r) => `${r.status}\t${r.metric.toFixed(6)}\t${r.description}`).join("\n")
    : "(no experiments yet)";

  const stagnationMode =
    state.stagnationCount >= config.stagnation.doubleThreshold
      ? "RADICAL: Try combining the two best past approaches or fundamentally different strategies."
      : state.stagnationCount >= config.stagnation.threshold
        ? "EXPLORATORY: Standard tweaks aren't working. Try bigger structural changes."
        : "NORMAL: Propose a focused, incremental improvement.";

  const prompt = `You are an autonomous research agent optimizing: ${config.objective}

METRIC: ${config.metric.name} (${config.metric.direction.replace("_", " ")})
BEST SO FAR: ${state.bestMetric} (commit ${state.bestCommit})
EXPERIMENTS WITHOUT IMPROVEMENT: ${state.stagnationCount}
MODE: ${stagnationMode}

RECENT EXPERIMENT HISTORY (status, metric, description):
${historyBlock}

TARGET FILE (${config.targetFile}):
\`\`\`
${targetContent.slice(0, 8000)}
\`\`\`

READ-ONLY FILES (do NOT modify): ${config.readOnlyFiles.join(", ") || "none"}

SIMPLICITY CRITERION: All else being equal, simpler is better. A small improvement that adds
ugly complexity is not worth it. Removing something and getting equal or better results is a win.

${config.notes ? `NOTES: ${config.notes}` : ""}

YOUR TASK:
1. Analyze the history to avoid repeating failed approaches
2. Propose ONE focused change to ${config.targetFile}
3. Output the COMPLETE new contents of ${config.targetFile}
4. Start your response with a one-line hypothesis: "HYPOTHESIS: ..."
5. Then output the file between \`\`\` markers

Do NOT modify any read-only files. Do NOT install new packages.`;

  // Resolve model via OmniRoute tier resolver
  let resolvedModel = "";
  try {
    const tierResult = await $`bun /home/workspace/Skills/tier-resolver/scripts/tier-resolve.ts --json ${prompt.slice(0, 200)}`.quiet().nothrow();
    if (tierResult.exitCode === 0) {
      const parsed = JSON.parse(tierResult.stdout.toString());
      resolvedModel = parsed.combo || parsed.resolvedCombo || "";
    }
  } catch {}

  // Call executor via bridge
  const bridgePath = `/home/workspace/Skills/zo-swarm-executors/bridges/${executor}-bridge.sh`;
  if (!existsSync(bridgePath)) {
    throw new Error(`Bridge not found: ${bridgePath}`);
  }

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (resolvedModel) env.SWARM_RESOLVED_MODEL = resolvedModel;

  const resultPath = join(workDir, `.autoloop-executor-result-${Date.now()}.json`);
  env.RESULT_PATH = resultPath;
  env.SWARM_TASK_ID = `autoloop-${Date.now()}`;

  const result = await $`bash ${bridgePath} ${prompt}`.env(env).cwd(workDir).quiet().nothrow();
  const output = result.stdout.toString();

  let costUSD = 0;
  let costReported = false;
  try {
    const structured = JSON.parse(readFileSync(resultPath, "utf-8"));
    const reported = structured?.metrics?.totalCostUsd;
    if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
      costUSD = reported;
      costReported = true;
    }
  } catch {
    // Executors without structured cost telemetry remain usable, but the summary says so.
  } finally {
    try { unlinkSync(resultPath); } catch { /* ignore */ }
  }

  if (result.exitCode !== 0 || !output.trim()) {
    throw new Error(`Executor failed: ${result.stderr.toString().slice(0, 1000)}`);
  }

  // Extract hypothesis
  const hypothesisMatch = output.match(/HYPOTHESIS:\s*(.+)/i);
  const hypothesis = hypothesisMatch ? hypothesisMatch[1].trim().slice(0, 200) : "unknown change";

  // Extract new file content
  const codeMatch = output.match(/```[\w]*\n([\s\S]*?)```/);
  if (!codeMatch) {
    throw new Error("Agent did not output file content in code blocks");
  }

  const newContent = codeMatch[1];
  const targetPath = resolve(workDir, config.targetFile);
  writeFileSync(targetPath, newContent);

  return { hypothesis, costUSD, costReported };
}

// ---------------------------------------------------------------------------
// Results TSV
// ---------------------------------------------------------------------------

function initResultsTSV(path: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, "commit\tmetric\tstatus\tdescription\ttimestamp\tduration_ms\n");
  }
}

function appendResult(path: string, record: ExperimentRecord): void {
  const line = `${record.commit}\t${record.metric.toFixed(6)}\t${record.status}\t${record.description}\t${record.timestamp}\t${record.durationMs}\n`;
  appendFileSync(path, line);
}

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

function writeSummary(config: ProgramConfig, state: LoopState, workDir: string, reason: string): void {
  const keeps = state.results.filter((r) => r.status === "keep");
  const discards = state.results.filter((r) => r.status === "discard");
  const crashes = state.results.filter((r) => r.status === "crash");
  const elapsed = ((Date.now() - state.startTime) / 3600000).toFixed(1);

  const summary = `# Autoloop Summary: ${config.name}

**Stopped**: ${reason}
**Branch**: ${state.branch}
**Duration**: ${elapsed} hours
**Experiments**: ${state.experimentCount} total (${keeps.length} kept, ${discards.length} discarded, ${crashes.length} crashed)
**Best ${config.metric.name}**: ${state.bestMetric} (commit ${state.bestCommit})
**Reported executor cost**: $${state.totalCostUSD.toFixed(4)}
**Calls without cost telemetry**: ${state.unreportedCostCalls}
**Improvement rate**: ${((keeps.length / Math.max(1, state.experimentCount)) * 100).toFixed(1)}%

## Top Improvements
${keeps
  .sort((a, b) =>
    config.metric.direction === "lower_is_better" ? a.metric - b.metric : b.metric - a.metric
  )
  .slice(0, 5)
  .map((r) => `- ${r.commit}: ${r.metric.toFixed(6)} — ${r.description}`)
  .join("\n")}

## Crash Log
${crashes.length === 0 ? "No crashes." : crashes.map((r) => `- ${r.commit}: ${r.description}`).join("\n")}
`;

  const summaryPath = join(workDir, `autoloop-summary-${config.name}.md`);
  writeFileSync(summaryPath, summary);
  console.log(`\nSummary written to ${summaryPath}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`Usage: autoloop.ts --program <path/to/program.md> [options]

Options:
  --executor <name>  Proposal executor (default: claude-code)
  --resume           Resume today's existing autoloop branch
  --dry-run          Parse and validate configuration without changing Git
  --help             Show this help`);
}

export async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      program: { type: "string" },
      executor: { type: "string", default: "claude-code" },
      resume: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (!values.program) {
    printHelp();
    process.exit(1);
  }

  const programPath = resolve(values.program);
  if (!existsSync(programPath)) {
    console.error(`Program file not found: ${programPath}`);
    process.exit(1);
  }

  const config = parseProgram(programPath);
  const workDir = dirname(programPath);
  const executor = values.executor || "claude-code";

  if (!Number.isFinite(config.constraints.timeBudgetSeconds) || config.constraints.timeBudgetSeconds <= 0
    || !Number.isFinite(config.constraints.maxExperiments) || config.constraints.maxExperiments < 1
    || !Number.isFinite(config.constraints.maxDurationHours) || config.constraints.maxDurationHours <= 0
    || !Number.isFinite(config.constraints.maxCostUSD) || config.constraints.maxCostUSD < 0) {
    throw new Error("Program constraints must be finite and non-negative; time and experiment limits must be positive");
  }
  if (!config.objective || !config.metric.name || !config.metric.extract || !config.targetFile || !config.runCommand) {
    throw new Error("Program must define Objective, Metric name/extract, Target File, and Run Command");
  }
  if (!(["lower_is_better", "higher_is_better"] as string[]).includes(config.metric.direction)) {
    throw new Error(`Unsupported metric direction: ${config.metric.direction}`);
  }

  console.log(`\n=== Autoloop: ${config.name} ===`);
  console.log(`Objective: ${config.objective}`);
  console.log(`Metric: ${config.metric.name} (${config.metric.direction})`);
  console.log(`Target: ${config.targetFile}`);
  console.log(`Run: ${config.runCommand}`);
  console.log(`Executor: ${executor}`);
  console.log(`Limits: ${config.constraints.maxExperiments} experiments, ${config.constraints.maxDurationHours}h, $${config.constraints.maxCostUSD}`);

  if (values["dry-run"]) {
    console.log("\n[DRY RUN] Config parsed successfully. Exiting.");
    process.exit(0);
  }

  const gitRoot = await assertSafeGitState(workDir, config.targetFile);

  // Create branch — slugify name so spaces don't break git branch names
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const nameSlug = config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const branchName = `autoloop/${nameSlug}-${dateTag}`;

  let activeBranch = branchName;
  if (values.resume) {
    if (!(await gitBranchExists(gitRoot, branchName))) {
      console.error(`Branch ${branchName} not found. Cannot resume.`);
      process.exit(1);
    }
    await $`git checkout ${branchName}`.cwd(gitRoot).quiet();
    console.log(`Resumed branch: ${branchName}`);
  } else {
    if (await gitBranchExists(gitRoot, branchName)) {
      // Append counter
      let counter = 2;
      while (await gitBranchExists(gitRoot, `${branchName}-${counter}`)) counter++;
      const uniqueBranch = `${branchName}-${counter}`;
      await $`git checkout -b ${uniqueBranch}`.cwd(gitRoot).quiet();
      activeBranch = uniqueBranch;
      console.log(`Created branch: ${uniqueBranch}`);
    } else {
      await $`git checkout -b ${branchName}`.cwd(gitRoot).quiet();
      console.log(`Created branch: ${branchName}`);
    }
  }

  // Run setup if defined
  if (config.setup) {
    console.log("\nRunning setup...");
    const setupResult = await $`bash -c ${config.setup}`.cwd(workDir).quiet().nothrow();
    if (setupResult.exitCode !== 0) {
      console.error(`Setup failed: ${setupResult.stderr.toString().slice(0, 1000)}`);
      process.exit(1);
    }
    console.log("Setup complete.");
    await assertSafeGitState(workDir, config.targetFile);
  }

  // Init results TSV
  const tsvPath = join(workDir, "results.tsv");
  initResultsTSV(tsvPath);

  // Run baseline
  console.log("\nRunning baseline...");
  const baseline = await runExperiment(config, workDir);
  if (baseline.crashed) {
    console.error(`Baseline crashed: ${baseline.error}`);
    process.exit(1);
  }

  const baselineCommit = await gitShortHash(gitRoot);
  console.log(`Baseline: ${config.metric.name} = ${baseline.metric} (commit ${baselineCommit})`);

  const state: LoopState = {
    bestMetric: baseline.metric,
    bestCommit: baselineCommit,
    experimentCount: 1,
    stagnationCount: 0,
    totalCostUSD: 0,
    unreportedCostCalls: 0,
    startTime: Date.now(),
    results: [{
      commit: baselineCommit,
      metric: baseline.metric,
      status: "keep",
      description: "baseline",
      timestamp: new Date().toISOString(),
      durationMs: baseline.durationMs,
    }],
    branch: activeBranch,
  };

  appendResult(tsvPath, state.results[0]);

  // Main loop — NEVER STOP (until guardrails)
  console.log("\n--- Entering experiment loop (Ctrl+C to stop) ---\n");

  while (true) {
    // Check guardrails
    const elapsedHours = (Date.now() - state.startTime) / 3600000;
    if (state.experimentCount >= config.constraints.maxExperiments) {
      writeSummary(config, state, workDir, `Max experiments reached (${config.constraints.maxExperiments})`);
      break;
    }
    if (state.totalCostUSD >= config.constraints.maxCostUSD) {
      writeSummary(config, state, workDir, `Reported cost cap reached ($${config.constraints.maxCostUSD})`);
      break;
    }
    if (elapsedHours >= config.constraints.maxDurationHours) {
      writeSummary(config, state, workDir, `Max duration reached (${config.constraints.maxDurationHours}h)`);
      break;
    }
    if (state.stagnationCount >= config.stagnation.tripleThreshold) {
      writeSummary(config, state, workDir, `Triple stagnation threshold (${config.stagnation.tripleThreshold} experiments with no improvement)`);
      break;
    }

    state.experimentCount++;
    const expNum = state.experimentCount;

    // Propose change
    let hypothesis: string;
    let crashFixAttempts = 0;
    const maxCrashFixes = 3;

    try {
      const proposal = await proposeChange(config, state, workDir, executor);
      hypothesis = proposal.hypothesis;
      state.totalCostUSD += proposal.costUSD;
      if (!proposal.costReported) state.unreportedCostCalls++;
      await assertOnlyTargetChanged(workDir, config.targetFile);
    } catch (err: any) {
      await discardTargetChanges(workDir, config.targetFile);
      console.log(`[${expNum}] SKIP — Agent failed to propose: ${err.message?.slice(0, 200)}`);
      state.stagnationCount++;
      continue;
    }
    if (state.totalCostUSD >= config.constraints.maxCostUSD) {
      await discardTargetChanges(workDir, config.targetFile);
      writeSummary(config, state, workDir, `Reported cost cap reached ($${config.constraints.maxCostUSD})`);
      break;
    }

    // Commit
    let commit: string;
    try {
      commit = await gitCommit(
        workDir,
        config.targetFile,
        `experiment ${expNum}: ${hypothesis.slice(0, 100)}`
      );
    } catch {
      console.log(`[${expNum}] SKIP — Nothing to commit (no changes)`);
      state.stagnationCount++;
      continue;
    }

    // Run experiment
    const result = await runExperiment(config, workDir);

    if (result.crashed) {
      // Attempt fix loop
      let fixed = false;
      while (crashFixAttempts < maxCrashFixes) {
        crashFixAttempts++;
        console.log(`[${expNum}] CRASH (attempt ${crashFixAttempts}/${maxCrashFixes}): ${result.error?.slice(0, 100)}`);

        try {
          // Ask agent to fix the crash
          const proposal = await proposeChange(config, {
            ...state,
            results: [...state.results, {
              commit, metric: 0, status: "crash",
              description: `CRASH: ${result.error?.slice(0, 200)}`,
              timestamp: new Date().toISOString(), durationMs: result.durationMs,
            }],
          }, workDir, executor);
          hypothesis = proposal.hypothesis;
          state.totalCostUSD += proposal.costUSD;
          if (!proposal.costReported) state.unreportedCostCalls++;
          await assertOnlyTargetChanged(workDir, config.targetFile);

          await $`git add ${config.targetFile}`.cwd(workDir).quiet();
          await $`git commit --amend --no-edit`.cwd(workDir).quiet();

          const retryResult = await runExperiment(config, workDir);
          if (!retryResult.crashed) {
            // Fixed! Evaluate the result
            if (isBetter(retryResult.metric, state.bestMetric, config.metric.direction)) {
              state.bestMetric = retryResult.metric;
              state.bestCommit = commit;
              state.stagnationCount = 0;
              const record: ExperimentRecord = { commit, metric: retryResult.metric, status: "keep", description: `${hypothesis} (fixed after crash)`, timestamp: new Date().toISOString(), durationMs: retryResult.durationMs };
              state.results.push(record);
              appendResult(tsvPath, record);
              console.log(`[${expNum}] KEEP (fixed) — ${config.metric.name} = ${retryResult.metric} — ${hypothesis}`);
            } else {
              await gitResetLast(gitRoot);
              state.stagnationCount++;
              const record: ExperimentRecord = { commit, metric: retryResult.metric, status: "discard", description: `${hypothesis} (fixed but regressed)`, timestamp: new Date().toISOString(), durationMs: retryResult.durationMs };
              state.results.push(record);
              appendResult(tsvPath, record);
              console.log(`[${expNum}] DISCARD (fixed but worse) — ${config.metric.name} = ${retryResult.metric}`);
            }
            fixed = true;
            break;
          }
        } catch (error) {
          await discardTargetChanges(workDir, config.targetFile);
          if (error instanceof Error && error.message.startsWith("Executor modified files outside the target")) {
            throw error;
          }
        }
      }

      if (!fixed) {
        await gitResetLast(gitRoot);
        state.stagnationCount++;
        const record: ExperimentRecord = { commit, metric: 0, status: "crash", description: `${hypothesis} — ${result.error?.slice(0, 100)}`, timestamp: new Date().toISOString(), durationMs: result.durationMs };
        state.results.push(record);
        appendResult(tsvPath, record);
        console.log(`[${expNum}] CRASH (unfixable) — ${hypothesis.slice(0, 80)}`);
      }

    } else if (isBetter(result.metric, state.bestMetric, config.metric.direction)) {
      // Improvement — keep
      state.bestMetric = result.metric;
      state.bestCommit = commit;
      state.stagnationCount = 0;
      const record: ExperimentRecord = { commit, metric: result.metric, status: "keep", description: hypothesis, timestamp: new Date().toISOString(), durationMs: result.durationMs };
      state.results.push(record);
      appendResult(tsvPath, record);
      console.log(`[${expNum}] KEEP — ${config.metric.name} = ${result.metric} (best!) — ${hypothesis}`);

    } else {
      // Regression or equal — discard
      await gitResetLast(gitRoot);
      state.stagnationCount++;
      const record: ExperimentRecord = { commit, metric: result.metric, status: "discard", description: hypothesis, timestamp: new Date().toISOString(), durationMs: result.durationMs };
      state.results.push(record);
      appendResult(tsvPath, record);
      console.log(`[${expNum}] DISCARD — ${config.metric.name} = ${result.metric} — ${hypothesis}`);
    }

    // Stagnation alerts
    if (state.stagnationCount === config.stagnation.threshold) {
      console.log(`\n⚠ Stagnation threshold reached (${config.stagnation.threshold}). Switching to exploratory mode.\n`);
    } else if (state.stagnationCount === config.stagnation.doubleThreshold) {
      console.log(`\n⚠ Double stagnation (${config.stagnation.doubleThreshold}). Switching to radical mode.\n`);
    }
  }

  console.log(`\n=== Autoloop complete: ${state.experimentCount} experiments, best ${config.metric.name} = ${state.bestMetric} ===`);
}

if (import.meta.main) {
  process.on("SIGINT", () => {
    console.log("\n\nInterrupted by user. Progress saved via git commits and results.tsv.");
    process.exit(0);
  });
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
