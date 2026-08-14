import { describe, test, expect } from 'bun:test';
import {
  PROVIDER_FAILURE_REASONS,
  DEFAULT_MAX_REVISION_ROUNDS,
  DEFAULT_MAX_PROVIDER_CALLS_PER_PLAN,
  DEFAULT_MAX_COST_USD_PER_PLAN,
  classifyVerdictForAggregation,
  computePlanConsensus,
  classifyProviderHealth,
  isBudgetExceeded,
} from '../provider.js';
import type { ReviewerVerdict, CallAccounting } from '../types.js';

// ---------------------------------------------------------------------------
// Provider taxonomy constants
// ---------------------------------------------------------------------------

describe('provider taxonomy constants', () => {
  test('PROVIDER_FAILURE_REASONS covers all expected categories', () => {
    const reasons = PROVIDER_FAILURE_REASONS as readonly string[];
    expect(reasons).toContain('http_error');
    expect(reasons).toContain('timeout');
    expect(reasons).toContain('malformed_response');
    expect(reasons).toContain('all_failover_exhausted');
    expect(reasons).toContain('no_keys_configured');
    expect(reasons).toContain('network_unreachable');
  });

  test('budget defaults match SEED.yaml values', () => {
    expect(DEFAULT_MAX_REVISION_ROUNDS).toBe(3);
    expect(DEFAULT_MAX_PROVIDER_CALLS_PER_PLAN).toBe(12);
    expect(DEFAULT_MAX_COST_USD_PER_PLAN).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// classifyVerdictForAggregation
// ---------------------------------------------------------------------------

describe('classifyVerdictForAggregation', () => {
  const pass: ReviewerVerdict = {
    model: 'model-a',
    pass: true,
    confidence: 0.9,
    finding_type: 'none',
    claims: [],
  };
  const substantiveFail: ReviewerVerdict = {
    model: 'model-b',
    pass: false,
    confidence: 0.88,
    finding_type: 'substantive',
    claims: [{ claim: 'missing rollback', evidence: 'rollback: null', severity: 'high' }],
  };
  const providerFailure: ReviewerVerdict = {
    model: 'model-c',
    pass: false,
    confidence: 0.0,
    finding_type: 'provider_failure',
    claims: [],
    provider_error: { http_status: 503, message: 'API error: 503', all_failover_exhausted: true },
  };
  const abstention: ReviewerVerdict = {
    model: 'model-d',
    pass: false,
    confidence: 0.55,
    finding_type: 'abstention',
    abstention_reason: 'Insufficient context',
    claims: [],
  };
  const outOfScope: ReviewerVerdict = {
    model: 'model-e',
    pass: false,
    confidence: 0.72,
    finding_type: 'out_of_scope',
    claims: [],
  };
  const malformed: ReviewerVerdict = {
    model: 'model-f',
    pass: false,
    confidence: 0.72,
    finding_type: 'malformed_output',
    malformed_reason: 'model_applied_code_review_mode_to_yaml',
    claims: [],
  };

  test('passing verdict (finding_type: none) is substantive', () => {
    const c = classifyVerdictForAggregation(pass);
    expect(c.isSubstantive).toBe(true);
    expect(c.isInfrastructure).toBe(false);
    expect(c.isAbstention).toBe(false);
    expect(c.isOutOfScope).toBe(false);
  });

  test('substantive finding is substantive', () => {
    const c = classifyVerdictForAggregation(substantiveFail);
    expect(c.isSubstantive).toBe(true);
    expect(c.isInfrastructure).toBe(false);
    expect(c.isAbstention).toBe(false);
    expect(c.isOutOfScope).toBe(false);
  });

  test('provider_failure is infrastructure, not substantive', () => {
    const c = classifyVerdictForAggregation(providerFailure);
    expect(c.isSubstantive).toBe(false);
    expect(c.isInfrastructure).toBe(true);
    expect(c.isAbstention).toBe(false);
    expect(c.isOutOfScope).toBe(false);
  });

  test('abstention is neither substantive nor infrastructure', () => {
    const c = classifyVerdictForAggregation(abstention);
    expect(c.isSubstantive).toBe(false);
    expect(c.isInfrastructure).toBe(false);
    expect(c.isAbstention).toBe(true);
    expect(c.isOutOfScope).toBe(false);
  });

  test('out_of_scope is out-of-scope, not substantive', () => {
    const c = classifyVerdictForAggregation(outOfScope);
    expect(c.isSubstantive).toBe(false);
    expect(c.isInfrastructure).toBe(false);
    expect(c.isOutOfScope).toBe(true);
  });

  test('malformed_output is out-of-scope, not substantive', () => {
    const c = classifyVerdictForAggregation(malformed);
    expect(c.isSubstantive).toBe(false);
    expect(c.isOutOfScope).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computePlanConsensus — fixture-driven (zou-725 v1–v6)
// ---------------------------------------------------------------------------

describe('computePlanConsensus', () => {
  test('empty verdict list → unavailable', () => {
    expect(computePlanConsensus([])).toBe('unavailable');
  });

  test('v1: 2 substantive fails, 1 pass → rejected', () => {
    // 2/3 fail; N-1=2; failCount 2 >= 2
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: false, confidence: 0.92, finding_type: 'substantive', claims: [] },
      { model: 'b', pass: false, confidence: 0.88, finding_type: 'substantive', claims: [] },
      { model: 'c', pass: true, confidence: 0.70, finding_type: 'none', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('rejected');
  });

  test('v2: 4-model 2-2 split → escalate', () => {
    // passCount=2, failCount=2, N=4, threshold=3; neither ≥ 3
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: true,  confidence: 0.80, finding_type: 'none',        claims: [] },
      { model: 'b', pass: false, confidence: 0.75, finding_type: 'substantive', claims: [] },
      { model: 'c', pass: true,  confidence: 0.82, finding_type: 'none',        claims: [] },
      { model: 'd', pass: false, confidence: 0.78, finding_type: 'substantive', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('escalate');
  });

  test('v3: 2 passes + 1 provider_failure → passed (infrastructure excluded)', () => {
    // Infrastructure seat excluded; substantive N=2, N-1=1; passCount=2 ≥ 1
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: true,  confidence: 0.91, finding_type: 'none',             claims: [] },
      { model: 'b', pass: true,  confidence: 0.87, finding_type: 'none',             claims: [] },
      { model: 'c', pass: false, confidence: 0.0,  finding_type: 'provider_failure', claims: [],
        provider_error: { http_status: 503, message: 'API error: 503', all_failover_exhausted: true } },
    ];
    expect(computePlanConsensus(verdicts)).toBe('passed');
  });

  test('v4: 1 malformed_output + 2 passes → passed (out-of-scope excluded)', () => {
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: false, confidence: 0.72, finding_type: 'malformed_output', claims: [],
        malformed_reason: 'model_applied_code_review_mode_to_yaml' },
      { model: 'b', pass: true,  confidence: 0.90, finding_type: 'none', claims: [] },
      { model: 'c', pass: true,  confidence: 0.88, finding_type: 'none', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('passed');
  });

  test('v5: 2 passes + 1 abstention → passed (abstention excluded)', () => {
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: true,  confidence: 0.85, finding_type: 'none',      claims: [] },
      { model: 'b', pass: true,  confidence: 0.82, finding_type: 'none',      claims: [] },
      { model: 'c', pass: false, confidence: 0.55, finding_type: 'abstention',
        abstention_reason: 'Insufficient context', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('passed');
  });

  test('v6: all seats are provider_failure → unavailable', () => {
    const failed: ReviewerVerdict = {
      model: 'a', pass: false, confidence: 0, finding_type: 'provider_failure', claims: [],
      provider_error: { message: 'unreachable', all_failover_exhausted: true },
    };
    expect(computePlanConsensus([failed, { ...failed, model: 'b' }, { ...failed, model: 'c' }]))
      .toBe('unavailable');
  });

  test('v7: unanimous substantive rejection → rejected', () => {
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: false, confidence: 0.95, finding_type: 'substantive', claims: [] },
      { model: 'b', pass: false, confidence: 0.93, finding_type: 'substantive', claims: [] },
      { model: 'c', pass: false, confidence: 0.90, finding_type: 'substantive', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('rejected');
  });

  test('single passing substantive verdict → passed', () => {
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: true, confidence: 0.95, finding_type: 'none', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('passed');
  });

  test('single failing substantive verdict → rejected', () => {
    const verdicts: ReviewerVerdict[] = [
      { model: 'a', pass: false, confidence: 0.95, finding_type: 'substantive', claims: [] },
    ];
    expect(computePlanConsensus(verdicts)).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// classifyProviderHealth
// ---------------------------------------------------------------------------

describe('classifyProviderHealth', () => {
  test('http_error → degraded', () => {
    expect(classifyProviderHealth('http_error')).toBe('degraded');
  });

  test('timeout → degraded', () => {
    expect(classifyProviderHealth('timeout')).toBe('degraded');
  });

  test('malformed_response → degraded', () => {
    expect(classifyProviderHealth('malformed_response')).toBe('degraded');
  });

  test('all_failover_exhausted → unreachable', () => {
    expect(classifyProviderHealth('all_failover_exhausted')).toBe('unreachable');
  });

  test('no_keys_configured → unreachable', () => {
    expect(classifyProviderHealth('no_keys_configured')).toBe('unreachable');
  });

  test('network_unreachable → unreachable', () => {
    expect(classifyProviderHealth('network_unreachable')).toBe('unreachable');
  });
});

// ---------------------------------------------------------------------------
// isBudgetExceeded
// ---------------------------------------------------------------------------

describe('isBudgetExceeded', () => {
  const baseAccounting: CallAccounting = {
    calls_made: 5,
    calls_remaining: 7,
    estimated_cost_usd: 0.80,
    max_calls: 12,
    max_cost_usd: 2.0,
  };

  test('within all limits → not exceeded', () => {
    expect(isBudgetExceeded(baseAccounting, 0.10)).toBe(false);
  });

  test('calls_made at max_calls → exceeded', () => {
    expect(isBudgetExceeded({ ...baseAccounting, calls_made: 12 }, 0.01)).toBe(true);
  });

  test('next call would push cost over max → exceeded', () => {
    expect(isBudgetExceeded({ ...baseAccounting, estimated_cost_usd: 1.95 }, 0.10)).toBe(true);
  });

  test('next call exactly at limit → not exceeded', () => {
    expect(isBudgetExceeded({ ...baseAccounting, estimated_cost_usd: 1.80 }, 0.20)).toBe(false);
  });

  test('next call just over limit → exceeded', () => {
    expect(isBudgetExceeded({ ...baseAccounting, estimated_cost_usd: 1.80 }, 0.21)).toBe(true);
  });
});
