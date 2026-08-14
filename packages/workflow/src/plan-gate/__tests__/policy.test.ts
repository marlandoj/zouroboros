import { describe, test, expect } from 'bun:test';
import { evaluatePlanGatePolicy, isMandatoryGate } from '../policy.js';
import type { PlanArtifact, PlanGatePolicy } from '../types.js';

function artifact(overrides: Partial<PlanArtifact> = {}): PlanArtifact {
  return {
    id: 'test-artifact',
    title: 'Test plan',
    risk: 'low',
    tasks: [{ id: 'T1', title: 'Simple task', paths: ['src/index.ts'] }],
    acceptance_criteria: ['Tests pass'],
    exit_conditions: [{ name: 'done', criteria: 'CI green' }],
    rollback: 'revert T1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mandatory triggers
// ---------------------------------------------------------------------------

describe('evaluatePlanGatePolicy – mandatory triggers', () => {
  test('high-risk artifact → mandatory', () => {
    const policy = evaluatePlanGatePolicy(artifact({ risk: 'high' }));
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('artifact_risk_high');
  });

  test('SWARM execution mode → mandatory', () => {
    const policy = evaluatePlanGatePolicy(artifact(), { execution_mode: 'SWARM' });
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('execution_mode_swarm');
  });

  test('FORCE_SWARM execution mode → mandatory', () => {
    const policy = evaluatePlanGatePolicy(artifact(), { execution_mode: 'FORCE_SWARM' });
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('execution_mode_force_swarm');
  });

  test('execution mode matching is case-insensitive', () => {
    const policy = evaluatePlanGatePolicy(artifact(), { execution_mode: 'swarm' });
    expect(policy.mode).toBe('mandatory');
  });

  test('multi-phase dependent tasks → mandatory', () => {
    const a = artifact({
      tasks: [
        { id: 'T1', title: 'First', paths: [] },
        { id: 'T2', title: 'Second', paths: [], depends_on: ['T1'] },
      ],
    });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('multi_phase_dependent_tasks');
  });

  test('schema migration path → mandatory', () => {
    const a = artifact({ tasks: [{ id: 'T1', title: 'DB migration', paths: ['db/migrations/0042.sql'] }] });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('schema_change');
  });

  test('infrastructure path → mandatory', () => {
    const a = artifact({ tasks: [{ id: 'T1', title: 'Deploy', paths: ['infra/k8s/prod.yaml'] }] });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('infrastructure_change');
  });

  test('production config path → mandatory', () => {
    const a = artifact({ tasks: [{ id: 'T1', title: 'Update', paths: ['config/production.env'] }] });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('infrastructure_change');
  });

  test('security-sensitive path (vault) → mandatory', () => {
    const a = artifact({ tasks: [{ id: 'T1', title: 'Vault', paths: ['infra/vault/init.sh'] }] });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('security_sensitive');
  });

  test('financial path (payment) → mandatory', () => {
    const a = artifact({ tasks: [{ id: 'T1', title: 'Payment', paths: ['src/payment/processor.ts'] }] });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('financial_change');
  });

  test('irreversible path (drop_table) → mandatory', () => {
    const a = artifact({ tasks: [{ id: 'T1', title: 'Remove', paths: ['db/drop_table.sql'] }] });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('irreversible_change');
  });

  test('force_mandatory overrides low risk', () => {
    const policy = evaluatePlanGatePolicy(artifact({ risk: 'low' }), { force_mandatory: true });
    expect(policy.mode).toBe('mandatory');
    expect(policy.triggered_by).toContain('force_mandatory');
  });
});

// ---------------------------------------------------------------------------
// Advisory
// ---------------------------------------------------------------------------

describe('evaluatePlanGatePolicy – advisory', () => {
  test('low-risk plan with no mandatory triggers → advisory', () => {
    const policy = evaluatePlanGatePolicy(artifact());
    expect(policy.mode).toBe('advisory');
  });

  test('medium-risk plan with no mandatory triggers → advisory', () => {
    const policy = evaluatePlanGatePolicy(artifact({ risk: 'medium' }));
    expect(policy.mode).toBe('advisory');
  });

  test('documentation-only paths → advisory with documentation_only trigger', () => {
    const a = artifact({
      tasks: [
        { id: 'T1', title: 'Update docs', paths: ['docs/guide.md', 'README.md'] },
      ],
    });
    const policy = evaluatePlanGatePolicy(a);
    expect(policy.mode).toBe('advisory');
    expect(policy.triggered_by).toContain('documentation_only');
  });
});

// ---------------------------------------------------------------------------
// Exempt
// ---------------------------------------------------------------------------

describe('evaluatePlanGatePolicy – exempt', () => {
  test('force_exempt → exempt regardless of risk', () => {
    const policy = evaluatePlanGatePolicy(artifact({ risk: 'high' }), { force_exempt: true });
    expect(policy.mode).toBe('exempt');
    expect(policy.triggered_by).toContain('force_exempt');
  });

  test('force_exempt takes precedence over force_mandatory', () => {
    // force_exempt is checked first
    const policy = evaluatePlanGatePolicy(artifact(), {
      force_exempt: true,
      force_mandatory: true,
    });
    expect(policy.mode).toBe('exempt');
  });
});

// ---------------------------------------------------------------------------
// Policy output shape
// ---------------------------------------------------------------------------

describe('evaluatePlanGatePolicy – output shape', () => {
  test('returned policy always has mode, rationale, triggered_by', () => {
    const policy = evaluatePlanGatePolicy(artifact());
    expect(typeof policy.mode).toBe('string');
    expect(typeof policy.rationale).toBe('string');
    expect(Array.isArray(policy.triggered_by)).toBe(true);
  });

  test('rationale is non-empty string', () => {
    const policy = evaluatePlanGatePolicy(artifact());
    expect(policy.rationale.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// isMandatoryGate helper
// ---------------------------------------------------------------------------

describe('isMandatoryGate', () => {
  test('mandatory mode → true', () => {
    const policy: PlanGatePolicy = { mode: 'mandatory', rationale: 'required', triggered_by: [] };
    expect(isMandatoryGate(policy)).toBe(true);
  });

  test('advisory mode → false', () => {
    const policy: PlanGatePolicy = { mode: 'advisory', rationale: 'advisory', triggered_by: [] };
    expect(isMandatoryGate(policy)).toBe(false);
  });

  test('exempt mode → false', () => {
    const policy: PlanGatePolicy = { mode: 'exempt', rationale: 'exempt', triggered_by: [] };
    expect(isMandatoryGate(policy)).toBe(false);
  });
});
