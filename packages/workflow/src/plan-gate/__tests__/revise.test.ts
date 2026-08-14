import { describe, expect, test } from 'bun:test';
import { validPlan } from './fixtures.js';
import { runRevisionController } from '../revise.js';
import type { PlanReviewProvider, PlanReviewResult } from '../provider.js';

function result(decision: PlanReviewResult['decision']): PlanReviewResult {
  return {
    verdicts: decision === 'passed' ? [{
      model: 'test', pass: true, confidence: 1, finding_type: 'none', claims: [],
    }] : [],
    provider_health: { test: 'healthy' },
    call_accounting: {
      calls_made: 1, calls_remaining: 11, estimated_cost_usd: 0.1,
      max_calls: 12, max_cost_usd: 2,
    },
    decision,
  };
}

function provider(decisions: PlanReviewResult['decision'][], estimate = 0.1): PlanReviewProvider & { calls: number } {
  return {
    calls: 0,
    async estimateCost() { return estimate; },
    async checkHealth() { return { test: 'healthy' }; },
    async review() {
      const decision = decisions[Math.min(this.calls, decisions.length - 1)] ?? 'unavailable';
      this.calls += 1;
      return result(decision);
    },
  };
}

describe('runRevisionController', () => {
  test('stops on the first passing review', async () => {
    const mock = provider(['passed']);
    const output = await runRevisionController(validPlan(), mock);
    expect(output.decision).toBe('passed');
    expect(output.rounds).toHaveLength(1);
    expect(mock.calls).toBe(1);
  });

  test('caps unresolved reviews at three rounds', async () => {
    const mock = provider(['unavailable', 'escalate', 'escalate']);
    const output = await runRevisionController(validPlan(), mock);
    expect(output.decision).toBe('escalate');
    expect(output.rounds).toHaveLength(3);
    expect(mock.calls).toBe(3);
  });

  test('rejects deterministic defects without a provider call', async () => {
    const mock = provider(['passed']);
    const output = await runRevisionController(validPlan({ rollback: null }), mock);
    expect(output.decision).toBe('rejected');
    expect(output.rounds).toHaveLength(0);
    expect(mock.calls).toBe(0);
  });

  test('stops before a call that would exceed the cost ceiling', async () => {
    const mock = provider(['passed'], 0.2);
    const output = await runRevisionController(validPlan(), mock, 1, {
      initialAccounting: { estimated_cost_usd: 1.9, max_cost_usd: 2 },
    });
    expect(output.decision).toBe('escalate');
    expect(mock.calls).toBe(0);
    expect(output.escalation_reason).toContain('Budget ceiling');
  });
});
