import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeProcessReward, executeEvolution } from '../evolve/executor.js';
import type { Prescription, TrajectoryStep } from '../types.js';

// Set up a stable temp workspace at module load time so ZO_WORKSPACE is
// guaranteed to be set before bun 1.3.x starts scheduling describe callbacks.
const TEST_WORKSPACE = mkdtempSync(join(tmpdir(), 'zo-traj-'));
process.env.ZO_WORKSPACE = TEST_WORKSPACE;

afterAll(() => {
  delete process.env.ZO_WORKSPACE;
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
});

describe('computeProcessReward', () => {
  test('undefined for empty trajectory', () => {
    expect(computeProcessReward([])).toBeUndefined();
  });

  test('mean of step scores', () => {
    const steps: TrajectoryStep[] = [
      { index: 0, name: 's0', phase: 'setup', outcome: 'success', score: 1, durationMs: 5 },
      { index: 1, name: 's1', phase: 'run', outcome: 'partial', score: 0.5, durationMs: 7 },
      { index: 2, name: 's2', phase: 'measure', outcome: 'failure', score: 0, durationMs: 1 },
    ];
    expect(computeProcessReward(steps)).toBeCloseTo(0.5, 6);
  });

  test('all success → 1', () => {
    const steps: TrajectoryStep[] = [
      { index: 0, name: 'a', phase: 'setup', outcome: 'success', score: 1, durationMs: 1 },
      { index: 1, name: 'b', phase: 'run', outcome: 'success', score: 1, durationMs: 1 },
    ];
    expect(computeProcessReward(steps)).toBe(1);
  });
});

describe('executeEvolution trajectory recording', () => {

  function makePrescription(overrides: Partial<Prescription> = {}): Prescription {
    return {
      id: 'rx-test',
      timestamp: new Date().toISOString(),
      metric: {
        name: 'Memory Recall',
        value: 0.5,
        target: 0.8,
        critical: 0.3,
        weight: 0.2,
        score: 0.5,
        status: 'WARNING',
        trend: '—',
        detail: 'd',
        recommendation: 'r',
      },
      playbook: {
        id: 'pb',
        name: 'test-playbook',
        description: '',
        targetFile: null,
        metricCommand: 'echo 0.7',
        metricDirection: 'higher_is_better',
        constraints: [],
        maxFiles: 0,
        requiresApproval: false,
        runCommand: 'echo ran',
      },
      governor: { riskLevel: 'LOW', requiresHuman: false, approved: true, reason: 'ok' } as any,
      ...overrides,
    };
  }

  test('records run + measure steps for a successful prescription', async () => {
    const result = await executeEvolution(
      makePrescription(),
      { skipGovernor: true }
    );
    expect(result.trajectorySteps).toBeDefined();
    expect(result.trajectorySteps!.length).toBe(2); // run + measure
    expect(result.trajectorySteps![0].phase).toBe('run');
    expect(result.trajectorySteps![1].phase).toBe('measure');
    expect(result.processReward).toBeGreaterThan(0);
  });

  test('hands an eligible completed result to crystallization', async () => {
    const calls: Array<{ prescriptionId: string; delta: number }> = [];
    await executeEvolution(makePrescription(), {
      skipGovernor: true,
      candidateHandoff: async (rx, evolved) => {
        calls.push({ prescriptionId: rx.id, delta: evolved.delta });
        return { outcome: 'drafted', candidate_id: 'candidate-503' };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].prescriptionId).toBe('rx-test');
    expect(calls[0].delta).toBeCloseTo(0.2);
  });

  test('records setup steps when setupCommands provided', async () => {
    const result = await executeEvolution(
      makePrescription({
        playbook: {
          id: 'pb',
          name: 'with-setup',
          description: '',
          targetFile: null,
          metricCommand: 'echo 0.7',
          metricDirection: 'higher_is_better',
          constraints: [],
          maxFiles: 0,
          requiresApproval: false,
          setupCommands: ['true', 'echo ok'],
          runCommand: 'echo ran',
        },
      }),
      { skipGovernor: true }
    );
    expect(result.trajectorySteps!.length).toBe(4); // 2 setup + run + measure
    expect(result.trajectorySteps![0].phase).toBe('setup');
    expect(result.trajectorySteps![1].phase).toBe('setup');
  });

  test('halts trajectory at failed setup step', async () => {
    const result = await executeEvolution(
      makePrescription({
        playbook: {
          id: 'pb',
          name: 'failing-setup',
          description: '',
          targetFile: null,
          metricCommand: 'echo 0.7',
          metricDirection: 'higher_is_better',
          constraints: [],
          maxFiles: 0,
          requiresApproval: false,
          setupCommands: ['false', 'echo never-run'],
          runCommand: 'echo ran',
        },
      }),
      { skipGovernor: true }
    );
    expect(result.success).toBe(false);
    expect(result.trajectorySteps!.length).toBe(1); // only the failed setup
    expect(result.trajectorySteps![0].outcome).toBe('failure');
    expect(result.processReward).toBe(0);
  });

  test('measure step is partial when metric does not improve', async () => {
    const result = await executeEvolution(
      makePrescription({
        // baseline 0.5; metricCommand returns 0.4 (worse for higher_is_better)
        playbook: {
          id: 'pb',
          name: 'no-improve',
          description: '',
          targetFile: null,
          metricCommand: 'echo 0.4',
          metricDirection: 'higher_is_better',
          constraints: [],
          maxFiles: 0,
          requiresApproval: false,
          runCommand: 'echo ran',
        },
      }),
      { skipGovernor: true }
    );
    const measure = result.trajectorySteps!.find(s => s.phase === 'measure')!;
    expect(measure.outcome).toBe('partial');
    expect(measure.score).toBe(0.5);
  });

  test('dry-run skips trajectory recording (legacy path)', async () => {
    const result = await executeEvolution(
      makePrescription(),
      { dryRun: true, skipGovernor: false }
    );
    expect(result.trajectorySteps).toBeUndefined();
  });
});
