import type { PlanReviewRequest, PlanReviewResult } from '../provider.js';

const request = JSON.parse(await Bun.stdin.text()) as PlanReviewRequest;
const result: PlanReviewResult = {
  verdicts: [{
    model: 'mock-provider',
    pass: true,
    confidence: 1,
    finding_type: 'none',
    claims: [],
  }],
  provider_health: { 'mock-provider': 'healthy' },
  call_accounting: {
    calls_made: 1,
    calls_remaining: 11,
    estimated_cost_usd: 0,
    max_calls: 12,
    max_cost_usd: 2,
  },
  decision: request.deterministic_report.passed ? 'passed' : 'rejected',
};

process.stdout.write(`${JSON.stringify(result)}\n`);
