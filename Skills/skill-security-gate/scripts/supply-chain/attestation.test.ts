import { describe, expect, it } from 'bun:test';
import { buildAttestation, sourceDigest } from './attestation.js';
import type { SupplyChainReport } from './types.js';

const report: SupplyChainReport = {
  check: 'supply-chain',
  timestamp: '2026-07-11T00:00:00.000Z',
  checksRun: ['mcp-policy', 'action-pin'],
  findings: [{
    target: 'workflow.yml', category: 'action-pin', severity: 'critical', finding: 'mutable ref',
    evidence: 'uses: owner/action@main', remediation: 'pin SHA',
  }],
  summary: { critical: 1, warning: 0, info: 0 },
  passed: false,
};

describe('supply-chain attestation', () => {
  it('is stable across report timestamp and ordering', () => {
    const changed = { ...report, timestamp: '2027-01-01T00:00:00.000Z', checksRun: [...report.checksRun].reverse() };
    expect(sourceDigest(changed)).toBe(sourceDigest(report));
  });

  it('changes when evidence changes', () => {
    const changed = { ...report, findings: [{ ...report.findings[0], evidence: 'different' }] };
    expect(sourceDigest(changed)).not.toBe(sourceDigest(report));
  });

  it('carries result and deterministic digest', () => {
    const attestation = buildAttestation(report);
    expect(attestation.schemaVersion).toBe(1);
    expect(attestation.reportPassed).toBe(false);
    expect(attestation.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(attestation.reviewRequired).toBe(0);
  });
});
