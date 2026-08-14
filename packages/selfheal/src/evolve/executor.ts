/**
 * Evolution executor for prescribed improvements
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { Prescription, EvolutionResult, ScorecardSnapshot, TrajectoryStep } from '../types.js';
import {
  classifyRegime,
  formatRegimeAdvisory,
  type ProbeResult,
  type ProbeRunner,
  type RegimeClassification,
} from './regime-gate.js';
import {
  appendStrategyNote,
  loadStrategy,
  formatStrategyContext,
  nextIteration,
} from './strategy-md.js';
import { handoffEvolutionCandidate } from '../crystallize/runtime-handoff.js';
import { deriveHeldoutOverride, type ScorecardLike } from './heldout-verification.js';
import { getScorecard } from './scorecard.js';
import { scoreHiddenComposite } from '../introspect/holdout.js';

// Roadmap #11 flags — advisory default ON, enforce default OFF. Read per-call so the
// evolve loop honors env set at runtime and so byte-identical behavior holds when off.
const regimeGateEnabled = () => process.env.SELFHEAL_REGIME_GATE !== '0';
const regimeGateEnforce = () => process.env.SELFHEAL_REGIME_GATE_ENFORCE === '1';
const strategyMdEnabled = () => process.env.SELFHEAL_STRATEGY_MD !== '0';

// ZOU-882 B2 (ZNL-07): held-out post-flight verification for the LIBRARY promotion path.
// Default OFF ⇒ executeEvolution grades byte-identically to prior main. When ON,
// executeEvolution captures the same introspect scorecard + hidden held-out composite the
// standalone strong path captures and grades success through the shared verifyHeldout —
// closing the eval-production parity gap (a script-mode Goodhart-drifted gain could
// otherwise crystallize here without any held-out check). Fail-closed on unmeasurable
// evidence. Read per-call so byte-identical behavior holds when off.
const heldoutEnabled = () => process.env.SELFHEAL_EVOLVE_HELDOUT === '1';

function introspectCliPath(): string {
  return join(getWorkspace(), 'packages/selfheal/src/cli/introspect.ts');
}

/**
 * Compute aggregate process reward as the mean of step scores. Returns
 * undefined for empty trajectories so callers can distinguish "no trajectory
 * recorded" from "perfect zero reward".
 */
export function computeProcessReward(steps: TrajectoryStep[]): number | undefined {
  if (steps.length === 0) return undefined;
  const sum = steps.reduce((a, s) => a + s.score, 0);
  return sum / steps.length;
}

function getWorkspace(): string {
  return getWorkspaceRoot();
}

function getResultsDir(): string {
  return join(getWorkspace(), 'Seeds/zouroboros/results');
}

function run(cmd: string, timeout = 120000): { stdout: string; ok: boolean; code: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: getWorkspace(),
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), ok: true, code: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || '').toString().trim(), ok: false, code: e.status ?? 1 };
  }
}

function measureMetric(cmd: string): number | null {
  const result = run(cmd, 60000);
  if (!result.ok) return null;
  const num = parseFloat(result.stdout);
  return isNaN(num) ? null : num;
}

function resolveConstitutionGate(): { path: string; rootArgs: string[] } {
  const explicit = process.env.ZOUROBOROS_CONSTITUTION_GATE;
  if (explicit) return { path: explicit, rootArgs: [] };

  const workspace = getWorkspace();
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const candidates = [
    { path: join(workspace, 'Skills/zouroboros-governance/scripts/constitution-gate.ts'), root: workspace },
    { path: join(repository, 'Skills/zouroboros-governance/scripts/constitution-gate.ts'), root: repository },
  ];
  const local = candidates.find((candidate) => existsSync(candidate.path));
  if (!local) {
    return {
      path: '/home/workspace/Skills/zouroboros-governance/scripts/constitution-gate.ts',
      rootArgs: [],
    };
  }

  const nestedCanonical = join(local.root, 'zouroboros');
  const canonicalRoot = existsSync(join(nestedCanonical, 'ZOUROBOROS.md'))
    && existsSync(join(nestedCanonical, 'CONSTITUTION.md'))
    ? nestedCanonical
    : local.root;
  return {
    path: local.path,
    rootArgs: ['--canonical-root', canonicalRoot, '--mirror-root', local.root],
  };
}

function constitutionalPreflight(prescription: Prescription, humanApproved: boolean): string | null {
  const gate = resolveConstitutionGate();
  const commandSurface = [
    prescription.playbook.description,
    prescription.program || '',
    prescription.playbook.runCommand || '',
    ...(prescription.playbook.setupCommands || []),
  ].join('\n');
  const input = {
    operation: `selfheal:${prescription.playbook.id}`,
    description: prescription.playbook.description || prescription.playbook.name,
    targetFiles: prescription.playbook.targetFile ? [prescription.playbook.targetFile] : [],
    modifiesModelWeights: /\b(fine[- ]?tun|train(?:ing)?\s+(?:a\s+)?model|model\s+weights?|gradient)\b/i.test(commandSurface),
    reversible: true,
    rollbackPlan: 'Revert the candidate commit and retain the incumbent prescription result.',
    blastRadius: prescription.governor.riskLevel === 'HIGH'
      ? 'high'
      : prescription.governor.riskLevel === 'MEDIUM' ? 'shared' : 'local',
    humanApproved,
    provenance: {
      rationale: prescription.governor.reason,
      evidence: [`prescription:${prescription.id}`, `metric:${prescription.metric.name}`],
      actor: 'zouroboros-selfheal',
      traceId: prescription.id,
    },
    budgetBounded: Number.isInteger(prescription.playbook.maxFiles) && prescription.playbook.maxFiles >= 0,
    layerIntegrity: true,
    failClosed: true,
  };

  try {
    const output = execFileSync('bun', [
      gate.path,
      'check',
      ...gate.rootArgs,
      '--phase',
      'preflight',
      '--input',
      JSON.stringify(input),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const decision = JSON.parse(output) as { decision?: string; violations?: Array<{ code: string }> };
    if (decision.decision !== 'ALLOW') {
      return `Constitution blocked: ${(decision.violations || []).map((item) => item.code).join(', ') || 'invalid decision'}`;
    }
    return null;
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    return `Constitution gate unavailable or rejected the prescription: ${detail.slice(0, 500)}`;
  }
}

async function executeAutoloopMode(
  prescription: Prescription,
  priorContext = '',
): Promise<EvolutionResult> {
  // Write program to the workspace root so that autoloop's dirname(programPath) resolves
  // to the git root — required for targetFile/runCmd relative paths to work.
  const programPath = join(getWorkspace(), `z-prescription-${prescription.id}.md`);

  if (prescription.program) {
    // Compounding memory (roadmap #11): surface prior attempts on this playbook to the
    // loop. Empty context (fresh playbook / flag off) ⇒ program written byte-identically.
    const body = priorContext
      ? `## Prior strategy notes (advisory)\n\n${priorContext}\n\n---\n\n${prescription.program}`
      : prescription.program;
    writeFileSync(programPath, body);
  }

  console.error(`  [evolve] Starting autoloop: ${prescription.playbook.name}`);

  const start = Date.now();
  const result = run(
    `bun Skills/zouroboros/skills/workflow/scripts/autoloop/autoloop.ts --program "${programPath}" 2>&1`,
    8 * 60 * 60 * 1000 // 8 hour timeout
  );
  const durationMs = Date.now() - start;

  const success = result.ok && result.stdout.includes('KEEP');

  // Parse autoloop verdict markers for trajectory.
  // KEEP/DISCARD/ITERATE markers appear in autoloop stdout per iteration
  // when the loop finishes. Approximate: split on "verdict:" lines.
  const trajectorySteps: TrajectoryStep[] = [];
  const verdictLines = result.stdout.split('\n').filter(l => /\bverdict\b/i.test(l));
  if (verdictLines.length > 0) {
    verdictLines.forEach((line, i) => {
      const upper = line.toUpperCase();
      let outcome: TrajectoryStep['outcome'] = 'partial';
      let score = 0.5;
      if (upper.includes('KEEP')) { outcome = 'success'; score = 1.0; }
      else if (upper.includes('DISCARD')) { outcome = 'failure'; score = 0.0; }
      else if (upper.includes('ITERATE')) { outcome = 'partial'; score = 0.5; }
      trajectorySteps.push({
        index: i,
        name: `autoloop_iteration_${i}`,
        phase: 'autoloop',
        outcome,
        score,
        durationMs: 0,
        detail: line.slice(0, 200),
      });
    });
  } else {
    trajectorySteps.push({
      index: 0,
      name: 'autoloop_run',
      phase: 'autoloop',
      outcome: success ? 'success' : 'failure',
      score: success ? 1 : 0,
      durationMs,
      detail: result.stdout.slice(0, 200),
    });
  }

  return {
    prescriptionId: prescription.id,
    success,
    baseline: { composite: prescription.metric.score, metrics: [] },
    postFlight: null,
    delta: 0,
    reverted: !success,
    detail: result.stdout.slice(0, 500),
    trajectorySteps,
    processReward: computeProcessReward(trajectorySteps),
  };
}

async function executeScriptMode(prescription: Prescription): Promise<EvolutionResult> {
  console.error(`  [evolve] Executing script mode: ${prescription.playbook.name}`);

  const trajectorySteps: TrajectoryStep[] = [];
  let stepIndex = 0;

  // Run setup commands — one trajectory step per command.
  if (prescription.playbook.setupCommands) {
    for (const cmd of prescription.playbook.setupCommands) {
      console.error(`  [evolve] Setup: ${cmd.slice(0, 60)}...`);
      const t0 = Date.now();
      const setupResult = run(cmd);
      const dur = Date.now() - t0;
      trajectorySteps.push({
        index: stepIndex++,
        name: `setup_${stepIndex - 1}`,
        phase: 'setup',
        outcome: setupResult.ok ? 'success' : 'failure',
        score: setupResult.ok ? 1 : 0,
        durationMs: dur,
        detail: setupResult.stdout.slice(0, 200),
      });
      if (!setupResult.ok) {
        return {
          prescriptionId: prescription.id,
          success: false,
          baseline: { composite: prescription.metric.score, metrics: [] },
          postFlight: null,
          delta: 0,
          reverted: false,
          detail: `Setup failed: ${setupResult.stdout.slice(0, 200)}`,
          trajectorySteps,
          processReward: computeProcessReward(trajectorySteps),
        };
      }
    }
  }

  // Run main command
  const runCmd = prescription.playbook.runCommand || 'echo "No run command"';
  console.error(`  [evolve] Executing: ${runCmd.slice(0, 60)}...`);

  const t1 = Date.now();
  const result = run(runCmd, 300000);
  const runDur = Date.now() - t1;
  trajectorySteps.push({
    index: stepIndex++,
    name: 'run',
    phase: 'run',
    outcome: result.ok ? 'success' : 'failure',
    score: result.ok ? 1 : 0,
    durationMs: runDur,
    detail: result.stdout.slice(0, 200),
  });

  // Measure post-flight metric
  const t2 = Date.now();
  const postValue = measureMetric(prescription.playbook.metricCommand);
  const measureDur = Date.now() - t2;
  const baseline = prescription.metric.value;
  const delta = postValue !== null ? postValue - baseline : 0;

  const improved = prescription.playbook.metricDirection === 'higher_is_better'
    ? delta > 0
    : delta < 0;

  // Measure step: success = improved metric, partial = ran but no improvement,
  // failure = couldn't measure at all.
  let measureOutcome: TrajectoryStep['outcome'];
  let measureScore: number;
  if (postValue === null) { measureOutcome = 'failure'; measureScore = 0; }
  else if (improved) { measureOutcome = 'success'; measureScore = 1; }
  else { measureOutcome = 'partial'; measureScore = 0.5; }

  trajectorySteps.push({
    index: stepIndex++,
    name: 'measure',
    phase: 'measure',
    outcome: measureOutcome,
    score: measureScore,
    durationMs: measureDur,
    detail: postValue === null ? 'metric measurement returned null' : `value=${postValue} delta=${delta.toFixed(4)}`,
  });

  return {
    prescriptionId: prescription.id,
    success: result.ok,
    baseline: { composite: baseline, metrics: [{ name: prescription.metric.name, value: baseline, score: prescription.metric.score, status: prescription.metric.status }] },
    postFlight: postValue !== null ? {
      composite: postValue,
      metrics: [{ name: prescription.metric.name, value: postValue, score: postValue, status: improved ? 'HEALTHY' : prescription.metric.status }],
    } : null,
    delta,
    reverted: !improved && result.ok,
    detail: result.stdout.slice(0, 500),
    trajectorySteps,
    processReward: computeProcessReward(trajectorySteps),
  };
}

/**
 * Real cheap-probe runner for the regime gate: run the operator's deterministic command,
 * then measure the metric the ordinary way. Injected into the pure `classifyRegime` so the
 * classifier itself stays offline-testable. Any failure ⇒ the gate fail-safes to 'unknown'.
 */
function makeProbeRunner(prescription: Prescription): ProbeRunner {
  return (cmd: string): ProbeResult => {
    const probe = run(cmd, 60000);
    if (!probe.ok) {
      return { value: null, ok: false, detail: probe.stdout.slice(0, 120) };
    }
    const value = measureMetric(prescription.playbook.metricCommand);
    return {
      value,
      ok: value !== null,
      detail: value === null ? 'metric unparseable after cheap probe' : `metric=${value}`,
    };
  };
}

/**
 * Build the short-circuit result for an ENFORCED 'deterministic' regime: the cheap path
 * already met the target, so the 8h autoloop is skipped entirely and the cheap value is
 * recorded as the post-flight metric.
 */
function buildDeterministicResult(
  prescription: Prescription,
  c: RegimeClassification,
): EvolutionResult {
  const step: TrajectoryStep = {
    index: 0,
    name: 'regime_gate_short_circuit',
    phase: 'measure',
    outcome: 'success',
    score: 1,
    durationMs: 0,
    detail: c.rationale.slice(0, 200),
  };
  return {
    prescriptionId: prescription.id,
    success: true,
    baseline: { composite: prescription.metric.value, metrics: [] },
    postFlight: c.cheapValue !== null
      ? { composite: c.cheapValue, metrics: [{ name: prescription.metric.name, value: c.cheapValue, score: c.cheapValue, status: 'HEALTHY' }] }
      : null,
    delta: c.cheapValue !== null ? c.cheapValue - prescription.metric.value : 0,
    reverted: false,
    detail: `Regime gate short-circuit (enforce): ${c.rationale}`,
    trajectorySteps: [step],
    processReward: 1,
  };
}

/**
 * Wrap a raw evolution result in held-out post-flight verification (ZOU-882 B2).
 * Captures the post-change scorecard, runs the shared `verifyHeldout`, and applies the
 * fail-closed override (unmeasurable ⇒ success forced false; never un-reverts). The
 * pre-change `baseline`/`hiddenBaseline` are captured by the caller BEFORE the mode
 * mutates anything. Called only when the flag is on, so flag-off is byte-identical.
 */
function verifyResultHeldout(
  raw: EvolutionResult,
  baseline: ScorecardLike | null,
  hiddenBaseline: number | null,
): EvolutionResult {
  const post = getScorecard(introspectCliPath(), run);
  const override = deriveHeldoutOverride({
    execSuccess: raw.success,
    reverted: raw.reverted,
    detail: raw.detail,
    hiddenBaseline,
    baseline,
    post,
    scoreHiddenAfter: scoreHiddenComposite,
  });
  return { ...raw, success: override.success, reverted: override.reverted, detail: override.detail };
}

/** One-line outcome summary for the compounding strategy note. */
function summarizeOutcome(r: EvolutionResult): string {
  const status = r.success ? 'success' : 'failed';
  const delta = r.delta !== 0 ? ` delta=${r.delta.toFixed(4)}` : '';
  return `${status}${delta}${r.reverted ? ' (reverted)' : ''}`;
}

export async function executeEvolution(
  prescription: Prescription,
  options: {
    dryRun?: boolean;
    skipGovernor?: boolean;
    candidateHandoff?: typeof handoffEvolutionCandidate;
  }
): Promise<EvolutionResult> {
  const { dryRun = false, skipGovernor = false } = options;

  // Governor check
  if (!skipGovernor && !prescription.governor.approved) {
    return {
      prescriptionId: prescription.id,
      success: false,
      baseline: { composite: prescription.metric.score, metrics: [] },
      postFlight: null,
      delta: 0,
      reverted: false,
      detail: `Governor blocked: ${prescription.governor.reason}`,
    };
  }

  if (dryRun) {
    return {
      prescriptionId: prescription.id,
      success: true,
      baseline: { composite: prescription.metric.score, metrics: [] },
      postFlight: null,
      delta: 0,
      reverted: false,
      detail: 'Dry run - no changes made',
    };
  }

  const constitutionBlock = constitutionalPreflight(prescription, skipGovernor);
  if (constitutionBlock) {
    return {
      prescriptionId: prescription.id,
      success: false,
      baseline: { composite: prescription.metric.score, metrics: [] },
      postFlight: null,
      delta: 0,
      reverted: false,
      detail: constitutionBlock,
    };
  }

  // Ensure results directory
  const resultsDir = getResultsDir();
  mkdirSync(resultsDir, { recursive: true });

  // ZOU-882 B2 held-out pre-flight (flag ON only): snapshot the verifiable state BEFORE any
  // mode run OR cheap probe mutates it. Flag OFF ⇒ never captured (byte-identical to main).
  const heldoutOn = heldoutEnabled();
  const heldoutBaseline = heldoutOn ? getScorecard(introspectCliPath(), run) : null;
  const hiddenBaseline = heldoutOn ? scoreHiddenComposite() : null;

  // --- roadmap #11: compounding strategy scratchpad + cheap-probe regime gate ---
  const strategyOn = strategyMdEnabled();
  // Prior-art context is fed into the autoloop program below. Empty (fresh playbook or
  // flag off) ⇒ program written byte-identically.
  const priorContext = strategyOn ? formatStrategyContext(loadStrategy(prescription.playbook.id)) : '';

  // Regime gate runs only ahead of the expensive autoloop escalation, and only when the
  // operator has declared a cheap probe. Absent the flag or the field ⇒ pure no-op.
  let classification: RegimeClassification | null = null;
  if (regimeGateEnabled() && prescription.program && prescription.playbook.cheapProbeCommand) {
    classification = classifyRegime(
      {
        cheapProbeCommand: prescription.playbook.cheapProbeCommand,
        metricDirection: prescription.playbook.metricDirection,
        baseline: prescription.metric.value,
        target: prescription.metric.target,
      },
      makeProbeRunner(prescription),
    );
    console.error('  ' + formatRegimeAdvisory(classification));
  }

  // ENFORCE only: a 'deterministic' classification skips the autoloop entirely.
  const shortCircuit =
    classification && regimeGateEnforce() && classification.regime === 'deterministic'
      ? buildDeterministicResult(prescription, classification)
      : null;

  // Execute based on mode (unless the regime gate short-circuited the escalation)
  const rawResult = shortCircuit
    ?? (prescription.program
      ? await executeAutoloopMode(prescription, priorContext)
      : await executeScriptMode(prescription));

  // ZOU-882 B2: single-source the held-out verification the standalone strong path uses,
  // then fail-closed. Governs success/reverted (and thus crystallization eligibility) for
  // EVERY produced result — mode or short-circuit. Flag OFF ⇒ result === rawResult.
  const result = heldoutOn
    ? verifyResultHeldout(rawResult, heldoutBaseline, hiddenBaseline)
    : rawResult;

  // Append one compounding strategy note summarizing this run (append-only, never rewrites).
  if (strategyOn) {
    appendStrategyNote({
      playbookId: prescription.playbook.id,
      prescriptionId: prescription.id,
      iteration: nextIteration(prescription.playbook.id),
      regime: classification ? classification.regime : (prescription.program ? 'agentic' : 'script'),
      action: shortCircuit ? 'cheap-probe short-circuit' : (prescription.program ? 'autoloop' : 'script'),
      outcome: summarizeOutcome(result),
      note: classification && classification.cheapValue !== null ? `cheapValue=${classification.cheapValue}` : undefined,
    });
  }

  // Save result
  const resultPath = join(resultsDir, `${prescription.id}-result.json`);
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const handoff = options.candidateHandoff ?? handoffEvolutionCandidate;
  try {
    const candidate = await handoff(prescription, result);
    if (candidate.outcome !== 'ineligible' && candidate.outcome !== 'unavailable') {
      console.error(`  [evolve] Crystallization: ${candidate.outcome}`);
    }
  } catch (err) {
    console.error(`  [evolve] Crystallization handoff unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.error(`  [evolve] Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (result.delta !== 0) {
    const sign = result.delta > 0 ? '+' : '';
    console.error(`  [evolve] Delta: ${sign}${(result.delta * 100).toFixed(1)}%`);
  }

  return result;
}
