import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  hashPlanArtifact,
  parsePlanArtifactInput,
  validatePlanArtifact,
  type ConsensusDecision,
  type PlanArtifact,
  type PlanReviewRequest,
  type PlanReviewResult,
} from 'zouroboros-workflow/plan-gate';

export interface LegacyConsensusVerdict {
  status: 'passed' | 'rejected' | 'escalate' | 'skipped' | 'error';
  pass: boolean | null;
  detail: string;
}

export interface SelfHealPlanGateShadow {
  enabled: boolean;
  authoritative: 'legacy';
  legacy_decision: ConsensusDecision;
  shared_decision: ConsensusDecision | 'disabled';
  parity: boolean | null;
  migration_blocked: boolean;
  failed_rounds: number;
  first_failure_at?: string;
  divergence_report?: string;
  detail: string;
}

interface ParityState {
  version: 1;
  total_comparisons: number;
  failed_rounds: number;
  first_failure_at?: string;
  last_comparison_at: string;
  migration_blocked: boolean;
}

export interface SelfHealPlanGateShadowOptions {
  seed: string;
  title: string;
  taskTitle: string;
  legacy: LegacyConsensusVerdict;
  enabled?: boolean;
  workspaceRoot?: string;
  statePath?: string;
  reportDir?: string;
  now?: Date;
  sharedResult?: PlanReviewResult;
}

export interface LegacyConsensusOptions {
  criteria: string;
  label: string;
  workspaceRoot?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

function workspaceRoot(explicit?: string): string {
  return explicit ?? process.env.ZO_WORKSPACE ?? '/home/workspace';
}

function defaultStatePath(root: string): string {
  return join(root, '.zouroboros/plan-gate/selfheal-parity.json');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalLegacyDecision(verdict: LegacyConsensusVerdict): ConsensusDecision {
  if (verdict.status === 'passed') return 'passed';
  if (verdict.status === 'rejected') return 'rejected';
  if (verdict.status === 'escalate') return 'escalate';
  return 'unavailable';
}

export function normalizeSelfHealSeed(
  seed: string,
  options: Pick<SelfHealPlanGateShadowOptions, 'title' | 'taskTitle'>,
): PlanArtifact {
  const parsed = parsePlanArtifactInput(seed, 'yaml');
  const id = asString(parsed.id) ?? `selfheal-${randomUUID()}`;
  const acceptance = Array.isArray(parsed.acceptance_criteria)
    ? parsed.acceptance_criteria
    : ['The target metric improves without regressions.'];
  const exits = Array.isArray(parsed.exit_conditions)
    ? parsed.exit_conditions.map((value: unknown, index: number) => {
        const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          name: asString(record.name) ?? `exit-${index + 1}`,
          criteria: asString(record.criteria) ?? asString(record.description) ?? String(value),
        };
      })
    : [{ name: 'verified', criteria: 'The prescribed improvement is verified.' }];
  return {
    id,
    title: options.title,
    description: asString(parsed.goal) ?? 'Zouroboros self-heal prescription.',
    risk: 'high',
    revision: 1,
    tasks: [{ id: 'SELFHEAL-1', title: options.taskTitle, depends_on: [] }],
    acceptance_criteria: acceptance as PlanArtifact['acceptance_criteria'],
    exit_conditions: exits,
    rollback: 'Keep the legacy self-heal prescription decision authoritative and discard the candidate change.',
    protected_behavior: ['The legacy governor and bespoke standalone decision remain authoritative.'],
    source_seed: parsed,
  };
}

function unavailableResult(): PlanReviewResult {
  return {
    verdicts: [],
    provider_health: {},
    call_accounting: {
      calls_made: 0, calls_remaining: 12, estimated_cost_usd: 0,
      max_calls: 12, max_cost_usd: 2,
    },
    decision: 'unavailable',
  };
}

function runSharedAdapter(request: PlanReviewRequest, root: string): PlanReviewResult {
  const script = process.env.SELFHEAL_PLAN_GATE_ADAPTER
    ?? join(root, 'Skills/consensus-gate/scripts/plan-consensus-gate.ts');
  if (!existsSync(script)) return unavailableResult();
  try {
    const output = execFileSync(process.execPath, [script], {
      cwd: root,
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: Number(process.env.SELFHEAL_PLAN_GATE_TIMEOUT_MS ?? 90_000),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(output.trim()) as PlanReviewResult;
  } catch {
    return unavailableResult();
  }
}

function loadParityState(path: string, now: Date): ParityState {
  if (!existsSync(path)) {
    return {
      version: 1, total_comparisons: 0, failed_rounds: 0,
      last_comparison_at: now.toISOString(), migration_blocked: false,
    };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ParityState;
}

function persistParityState(path: string, state: ParityState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function recordComparison(
  statePath: string,
  reportDir: string,
  parity: boolean,
  legacy: ConsensusDecision,
  shared: ConsensusDecision,
  now: Date,
): { state: ParityState; report?: string } {
  const state = loadParityState(statePath, now);
  state.total_comparisons += 1;
  state.last_comparison_at = now.toISOString();
  if (parity) {
    state.failed_rounds = 0;
    delete state.first_failure_at;
  } else {
    state.failed_rounds += 1;
    state.first_failure_at ??= now.toISOString();
  }
  const stalledDays = state.first_failure_at
    ? (now.getTime() - new Date(state.first_failure_at).getTime()) / 86_400_000
    : 0;
  state.migration_blocked = state.failed_rounds >= 3 || stalledDays >= 14;
  persistParityState(statePath, state);
  if (!state.migration_blocked) return { state };

  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const report = join(reportDir, `selfheal-plan-gate-divergence-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(report, `${JSON.stringify({
    status: 'blocked', reason: state.failed_rounds >= 3 ? 'three_failed_rounds' : 'fourteen_day_stall',
    legacy_decision: legacy, shared_decision: shared, state,
  }, null, 2)}\n`, { mode: 0o600 });
  return { state, report };
}

export function runSelfHealPlanGateShadow(
  options: SelfHealPlanGateShadowOptions,
): SelfHealPlanGateShadow {
  const enabled = options.enabled ?? process.env.SELFHEAL_PLAN_GATE_SHADOW === '1';
  const legacy = canonicalLegacyDecision(options.legacy);
  if (!enabled) {
    return {
      enabled: false, authoritative: 'legacy', legacy_decision: legacy,
      shared_decision: 'disabled', parity: null, migration_blocked: false,
      failed_rounds: 0, detail: 'shadow_disabled',
    };
  }

  const root = workspaceRoot(options.workspaceRoot);
  const artifact = normalizeSelfHealSeed(options.seed, options);
  const validation = validatePlanArtifact(artifact, { workspaceRoot: root });
  const result = validation.passed
    ? options.sharedResult ?? runSharedAdapter({
        artifact,
        artifact_sha256: hashPlanArtifact(artifact),
        deterministic_report: validation,
        revision: artifact.revision ?? 1,
        gate_run_id: `selfheal-shadow-${randomUUID()}`,
      }, root)
    : { ...unavailableResult(), decision: 'rejected' as const };
  const parity = legacy === result.decision;
  const now = options.now ?? new Date();
  const statePath = options.statePath ?? defaultStatePath(root);
  const reportDir = options.reportDir ?? join(root, '.zouroboros/plan-gate/divergence');
  const comparison = recordComparison(statePath, reportDir, parity, legacy, result.decision, now);
  return {
    enabled: true,
    authoritative: 'legacy',
    legacy_decision: legacy,
    shared_decision: result.decision,
    parity,
    migration_blocked: comparison.state.migration_blocked,
    failed_rounds: comparison.state.failed_rounds,
    first_failure_at: comparison.state.first_failure_at,
    divergence_report: comparison.report,
    detail: parity ? 'parity_match' : 'legacy_authority_preserved',
  };
}

export function runLegacyConsensusGate(
  source: string,
  options: LegacyConsensusOptions,
): LegacyConsensusVerdict {
  const root = workspaceRoot(options.workspaceRoot);
  const script = options.scriptPath
    ?? join(root, 'Skills/consensus-gate/scripts/consensus-gate.ts');
  if (!existsSync(script)) {
    return { status: 'skipped', pass: null, detail: 'consensus-gate script not found' };
  }
  const temp = join(tmpdir(), `selfheal-consensus-${randomUUID()}.txt`);
  try {
    writeFileSync(temp, source, { mode: 0o600 });
    const output = execFileSync(process.execPath, [
      script, 'validate', '--file', temp,
      '--criteria', options.criteria, '--label', options.label,
    ], {
      cwd: root, encoding: 'utf8', timeout: options.timeoutMs ?? 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = output.match(/Consensus:\s*(PASSED|REJECTED|ESCALATE|SPLIT)/i);
    const raw = match?.[1]?.toLowerCase();
    const status = raw === 'passed' ? 'passed'
      : raw === 'rejected' ? 'rejected'
      : raw === 'escalate' || raw === 'split' ? 'escalate'
      : 'error';
    return {
      status,
      pass: status === 'passed' ? true : status === 'rejected' ? false : null,
      detail: output.slice(-500),
    };
  } catch (error) {
    return {
      status: 'error', pass: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(temp, { force: true });
  }
}
