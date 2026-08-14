import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeEvolution } from '../evolve/executor.js';
import { strategyPath, loadStrategy } from '../evolve/strategy-md.js';
import type { Prescription } from '../types.js';

// Stable temp workspace so ZO_WORKSPACE (and thus strategy/program files) is sandboxed.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'zo-regime-int-'));

// Full-suite isolation: other test files also mutate/delete ZO_WORKSPACE + these flags in
// their own hooks, so we (re)assert our sandbox in beforeEach and restore prior values in
// afterEach rather than relying on module-load state a sibling's afterAll may clobber.
const ENV_KEYS = ['ZO_WORKSPACE', 'SELFHEAL_REGIME_GATE', 'SELFHEAL_REGIME_GATE_ENFORCE', 'SELFHEAL_STRATEGY_MD'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ZO_WORKSPACE = WORKSPACE;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
});

function makePrescription(over: {
  id: string;
  playbookId: string;
  program?: string | null;
  cheapProbeCommand?: string;
  metricCommand?: string;
  target?: number;
  value?: number;
}): Prescription {
  return {
    id: over.id,
    timestamp: new Date().toISOString(),
    metric: {
      name: 'Memory Recall',
      value: over.value ?? 0.5,
      target: over.target ?? 0.9,
      critical: 0.3,
      weight: 0.2,
      score: over.value ?? 0.5,
      status: 'WARNING',
      trend: '—',
      detail: 'd',
      recommendation: 'r',
    },
    playbook: {
      id: over.playbookId,
      name: over.playbookId,
      description: '',
      targetFile: null,
      metricCommand: over.metricCommand ?? 'echo 0.7',
      metricDirection: 'higher_is_better',
      constraints: [],
      maxFiles: 0,
      requiresApproval: false,
      runCommand: 'echo ran',
      cheapProbeCommand: over.cheapProbeCommand,
    },
    program: over.program ?? null,
    governor: { riskLevel: 'LOW', requiresHuman: false, approved: true, reason: 'ok' } as any,
  };
}

describe('regime gate — ENFORCE short-circuits the autoloop when deterministic', () => {
  test('cheap probe meets target ⇒ autoloop skipped, strategy note recorded', async () => {
    process.env.SELFHEAL_REGIME_GATE = '1';
    process.env.SELFHEAL_REGIME_GATE_ENFORCE = '1';
    process.env.SELFHEAL_STRATEGY_MD = '1';

    const rx = makePrescription({
      id: 'rx-sc',
      playbookId: 'sc-pb',
      program: '# expensive autoloop program',
      cheapProbeCommand: 'true',
      metricCommand: 'echo 0.95', // ≥ target 0.9 ⇒ deterministic
    });

    const result = await executeEvolution(rx, { skipGovernor: true });

    expect(result.success).toBe(true);
    expect(result.detail).toContain('short-circuit');
    expect(result.trajectorySteps?.[0].name).toBe('regime_gate_short_circuit');
    expect(result.delta).toBeCloseTo(0.45, 6); // 0.95 - 0.5

    const notes = loadStrategy('sc-pb', WORKSPACE);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const last = notes[notes.length - 1];
    expect(last.regime).toBe('deterministic');
    expect(last.action).toBe('cheap-probe short-circuit');
    expect(last.outcome).toContain('success');
  });
});

describe('regime gate — agentic does not short-circuit (advisory)', () => {
  test('cheap probe misses target ⇒ escalation proceeds, note records agentic', async () => {
    process.env.SELFHEAL_REGIME_GATE = '1';
    delete process.env.SELFHEAL_REGIME_GATE_ENFORCE; // advisory
    process.env.SELFHEAL_STRATEGY_MD = '1';

    const rx = makePrescription({
      id: 'rx-ag',
      playbookId: 'ag-pb',
      program: '# program',
      cheapProbeCommand: 'true',
      metricCommand: 'echo 0.6', // < target 0.9 ⇒ agentic
    });

    // Autoloop escalation runs; the hardcoded autoloop.ts path does not exist in the temp
    // workspace, so it errors out fast (no 8h hang). We only assert the gate classification
    // + strategy note here, not the escalation's own success.
    const result = await executeEvolution(rx, { skipGovernor: true });
    expect(result.prescriptionId).toBe('rx-ag');

    const notes = loadStrategy('ag-pb', WORKSPACE);
    const last = notes[notes.length - 1];
    expect(last.regime).toBe('agentic');
    expect(last.action).toBe('autoloop');
  });
});

describe('strategy.md — compounding memory feeds the next run', () => {
  test('second run prepends prior strategy notes to the autoloop program', async () => {
    process.env.SELFHEAL_REGIME_GATE = '1';
    delete process.env.SELFHEAL_REGIME_GATE_ENFORCE;
    process.env.SELFHEAL_STRATEGY_MD = '1';

    const mk = (id: string) =>
      makePrescription({
        id,
        playbookId: 'comp-pb',
        program: '# body',
        cheapProbeCommand: 'true',
        metricCommand: 'echo 0.6', // agentic — keeps program path (writes z-prescription file)
      });

    await executeEvolution(mk('rx-c1'), { skipGovernor: true }); // seeds one note
    await executeEvolution(mk('rx-c2'), { skipGovernor: true }); // should see prior context

    const programFile = join(WORKSPACE, 'z-prescription-rx-c2.md');
    expect(existsSync(programFile)).toBe(true);
    const written = readFileSync(programFile, 'utf-8');
    expect(written).toContain('## Prior strategy notes (advisory)');
    expect(written).toContain('prior_strategy_notes:');
    expect(written).toContain('# body');
  });
});

describe('flags OFF — byte-identical (no sidecar written)', () => {
  test('regime gate + strategy md disabled ⇒ no strategy file, plain script run', async () => {
    process.env.SELFHEAL_REGIME_GATE = '0';
    process.env.SELFHEAL_STRATEGY_MD = '0';

    const rx = makePrescription({
      id: 'rx-off',
      playbookId: 'off-pb',
      program: null, // script mode
      metricCommand: 'echo 0.7',
    });

    const result = await executeEvolution(rx, { skipGovernor: true });
    expect(result.success).toBe(true);
    expect(existsSync(strategyPath('off-pb', WORKSPACE))).toBe(false);
  });
});
