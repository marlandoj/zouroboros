import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validatePlanArtifact, type ConsensusDecision, type PlanReviewResult } from 'zouroboros-workflow/plan-gate';
import {
  normalizeSelfHealSeed,
  runLegacyConsensusGate,
  runSelfHealPlanGateShadow,
  type LegacyConsensusVerdict,
} from '../prescribe/plan-gate.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'selfheal-plan-gate-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const seed = `
id: seed-test
goal: Improve memory recall
acceptance_criteria:
  - Recall improves
  - Existing tests pass
exit_conditions:
  - name: verified
    criteria: Focused tests pass
`;

function legacy(status: LegacyConsensusVerdict['status']): LegacyConsensusVerdict {
  return {
    status,
    pass: status === 'passed' ? true : status === 'rejected' ? false : null,
    detail: `legacy ${status}`,
  };
}

function shared(decision: ConsensusDecision): PlanReviewResult {
  return {
    verdicts: [], provider_health: {}, decision,
    call_accounting: {
      calls_made: 0, calls_remaining: 12, estimated_cost_usd: 0,
      max_calls: 12, max_cost_usd: 2,
    },
  };
}

function compare(
  root: string,
  legacyDecision: LegacyConsensusVerdict,
  sharedDecision: ConsensusDecision,
  now = new Date('2026-07-17T00:00:00.000Z'),
) {
  return runSelfHealPlanGateShadow({
    seed,
    title: 'Self-heal memory plan',
    taskTitle: 'Improve memory recall',
    legacy: legacyDecision,
    enabled: true,
    workspaceRoot: root,
    statePath: join(root, 'state.json'),
    reportDir: join(root, 'reports'),
    sharedResult: shared(sharedDecision),
    now,
  });
}

describe('self-heal plan-gate parity', () => {
  test('normalizes legacy seed YAML into a valid shared plan artifact', () => {
    const artifact = normalizeSelfHealSeed(seed, {
      title: 'Self-heal memory plan', taskTitle: 'Improve memory recall',
    });
    expect(validatePlanArtifact(artifact).passed).toBe(true);
    expect(artifact.source_seed).toBeDefined();
  });

  test('disabled shadow is inert and writes no parity state', () => {
    const root = tempRoot();
    const statePath = join(root, 'state.json');
    const result = runSelfHealPlanGateShadow({
      seed, title: 'Plan', taskTitle: 'Task', legacy: legacy('passed'),
      enabled: false, workspaceRoot: root, statePath,
    });
    expect(result.shared_decision).toBe('disabled');
    expect(result.authoritative).toBe('legacy');
    expect(existsSync(statePath)).toBe(false);
  });

  test('matches the legacy taxonomy across regression decisions', () => {
    const cases: Array<[LegacyConsensusVerdict['status'], ConsensusDecision]> = [
      ['passed', 'passed'], ['rejected', 'rejected'], ['escalate', 'escalate'],
      ['error', 'unavailable'], ['skipped', 'unavailable'],
    ];
    for (const [legacyStatus, sharedStatus] of cases) {
      const result = compare(tempRoot(), legacy(legacyStatus), sharedStatus);
      expect(result.parity).toBe(true);
      expect(result.migration_blocked).toBe(false);
    }
  });

  test('keeps legacy authoritative and blocks migration after three failed rounds', () => {
    const root = tempRoot();
    expect(compare(root, legacy('passed'), 'rejected').failed_rounds).toBe(1);
    expect(compare(root, legacy('passed'), 'rejected').failed_rounds).toBe(2);
    const third = compare(root, legacy('passed'), 'rejected');
    expect(third.authoritative).toBe('legacy');
    expect(third.migration_blocked).toBe(true);
    expect(third.divergence_report).toBeDefined();
    expect(JSON.parse(readFileSync(third.divergence_report!, 'utf8')).reason)
      .toBe('three_failed_rounds');
  });

  test('blocks a parity stall after fourteen days even before three rounds', () => {
    const root = tempRoot();
    compare(root, legacy('passed'), 'rejected', new Date('2026-07-01T00:00:00.000Z'));
    const stalled = compare(
      root, legacy('passed'), 'rejected', new Date('2026-07-15T00:00:01.000Z'),
    );
    expect(stalled.failed_rounds).toBe(2);
    expect(stalled.migration_blocked).toBe(true);
    expect(JSON.parse(readFileSync(stalled.divergence_report!, 'utf8')).reason)
      .toBe('fourteen_day_stall');
  });

  test('centralizes legacy output parsing without shell interpolation', () => {
    const root = tempRoot();
    const script = join(root, 'fake-consensus.ts');
    writeFileSync(script, 'console.log("Consensus: ESCALATE")\n');
    const result = runLegacyConsensusGate('candidate', {
      criteria: 'safety', label: 'fixture', workspaceRoot: root, scriptPath: script,
    });
    expect(result.status).toBe('escalate');
    expect(result.pass).toBeNull();
  });

  test('both prescription paths consume the shared module', () => {
    const packageRoot = resolve(import.meta.dir, '..');
    const packaged = readFileSync(join(packageRoot, 'index.ts'), 'utf8');
    const standalone = readFileSync(join(packageRoot, 'standalone/prescribe.ts'), 'utf8');
    expect(packaged).toContain('runSelfHealPlanGateShadow');
    expect(standalone).toContain('runSelfHealPlanGateShadow');
    expect(standalone).toContain('runLegacyConsensusGate');
    expect(standalone).not.toContain('function runConsensusGate');
  });
});
