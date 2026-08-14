import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  computePlanConsensus,
  evaluatePlanGatePolicy,
  evaluatePlanGatePreflight,
  hashPlanInput,
  isBudgetExceeded,
  signApprovalReceipt,
  validatePlanArtifact,
  type ApprovalReceipt,
  type PlanArtifact,
  type ReviewerVerdict,
} from '../index.js';
import { validPlan } from './fixtures.js';

const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});

function receipt(artifact: PlanArtifact, expiry = '2099-01-01T00:00:00.000Z'): ApprovalReceipt {
  return signApprovalReceipt({
    receipt_type: 'approval',
    artifact_sha256: hashPlanInput(JSON.stringify(artifact), 'json'),
    gate_run_ids: ['replay-gate'],
    decision: 'accepted',
    actor: { id: 'operator', source: 'replay', authorization: 'project-owner' },
    timestamp: '2026-07-17T00:00:00.000Z',
    expiry,
    signed: false,
    enforcement_eligible: false,
    revision: artifact.revision ?? 1,
  }, { keyId: 'replay-key', privateKey: keys.privateKey });
}

function verdict(
  pass: boolean | null,
  finding_type: ReviewerVerdict['finding_type'] = pass === null ? 'provider_failure' : 'none',
): ReviewerVerdict {
  return { model: randomModel(), pass, confidence: 0.9, finding_type, claims: [] };
}

let modelSequence = 0;
function randomModel(): string {
  modelSequence += 1;
  return `replay-model-${modelSequence}`;
}

const baseAccounting = {
  calls_made: 1, calls_remaining: 11, estimated_cost_usd: 0.1,
  max_calls: 12, max_cost_usd: 2,
};

const replays: Array<{ id: string; expected: unknown; run: () => unknown }> = [
  { id: 'R01-valid-plan', expected: true, run: () => validatePlanArtifact(validPlan()).passed },
  { id: 'R02-high-risk-mandatory', expected: 'mandatory', run: () => evaluatePlanGatePolicy(validPlan()).mode },
  {
    id: 'R03-dependent-plan-mandatory', expected: 'mandatory', run: () => evaluatePlanGatePolicy(validPlan({
      risk: 'low', tasks: [
        { id: 'A', title: 'First', depends_on: [] },
        { id: 'B', title: 'Second', depends_on: ['A'] },
      ],
    })).mode,
  },
  {
    id: 'R04-cycle-rejected', expected: false, run: () => validatePlanArtifact(validPlan({ tasks: [
      { id: 'A', title: 'First', depends_on: ['B'] },
      { id: 'B', title: 'Second', depends_on: ['A'] },
    ] })).passed,
  },
  {
    id: 'R05-unknown-dependency-rejected', expected: false,
    run: () => validatePlanArtifact(validPlan({ tasks: [
      { id: 'A', title: 'First', depends_on: ['missing'] },
    ] })).passed,
  },
  {
    id: 'R06-parallel-write-conflict-rejected', expected: false,
    run: () => validatePlanArtifact(validPlan({
      tasks: [
        { id: 'A', title: 'First', depends_on: [], paths: ['/workspace/shared.ts'] },
        { id: 'B', title: 'Second', depends_on: [], paths: ['/workspace/shared.ts'] },
      ],
      dag: { waves: [{ wave: 1, tasks: ['A', 'B'] }] },
    })).passed,
  },
  { id: 'R07-missing-rollback-rejected', expected: false, run: () => validatePlanArtifact(validPlan({ rollback: null })).passed },
  { id: 'R08-missing-exit-rejected', expected: false, run: () => validatePlanArtifact(validPlan({ exit_conditions: [] })).passed },
  {
    id: 'R09-nonexistent-path-rejected', expected: false,
    run: () => validatePlanArtifact(validPlan({ tasks: [
      { id: 'A', title: 'First', depends_on: [], paths: ['/workspace/does-not-exist.ts'] },
    ] }), { workspaceRoot: '/workspace' }).passed,
  },
  {
    id: 'R10-yaml-json-hash-parity', expected: true, run: () => {
      const json = '{"id":"p","title":"P","tasks":[],"acceptance_criteria":[],"exit_conditions":[],"rollback":"r"}';
      const yaml = 'id: p\ntitle: P\ntasks: []\nacceptance_criteria: []\nexit_conditions: []\nrollback: r\n';
      return hashPlanInput(json, 'json') === hashPlanInput(yaml, 'yaml');
    },
  },
  {
    id: 'R11-markdown-yaml-hash-parity', expected: true, run: () => {
      const yaml = 'id: p\ntitle: P\ntasks: []\nacceptance_criteria: []\nexit_conditions: []\nrollback: r\n';
      return hashPlanInput(yaml, 'yaml') === hashPlanInput(`---\n${yaml}---\n`, 'markdown');
    },
  },
  {
    id: 'R12-shadow-would-hold', expected: 'proceed:true', run: () => {
      const result = evaluatePlanGatePreflight({ artifact: validPlan(), mode: 'shadow' });
      return `${result.action}:${result.would_hold}`;
    },
  },
  { id: 'R13-enforce-no-receipt-holds', expected: 'hold', run: () => evaluatePlanGatePreflight({ artifact: validPlan(), mode: 'enforce' }).action },
  {
    id: 'R14-valid-receipt-proceeds', expected: 'proceed', run: () => {
      const artifact = validPlan();
      return evaluatePlanGatePreflight({
        artifact, mode: 'enforce', receipt: receipt(artifact),
        trustedKeys: { 'replay-key': keys.publicKey },
        now: new Date('2026-07-18T00:00:00.000Z'),
      }).action;
    },
  },
  {
    id: 'R15-stale-receipt-holds', expected: 'artifact_hash_mismatch', run: () => {
      const artifact = validPlan();
      return evaluatePlanGatePreflight({
        artifact: { ...artifact, revision: 2 }, mode: 'enforce', receipt: receipt(artifact),
        trustedKeys: { 'replay-key': keys.publicKey },
      }).reason;
    },
  },
  {
    id: 'R16-expired-receipt-holds', expected: 'receipt_expired', run: () => {
      const artifact = validPlan();
      return evaluatePlanGatePreflight({
        artifact, mode: 'enforce', receipt: receipt(artifact, '2026-07-18T00:00:00.000Z'),
        trustedKeys: { 'replay-key': keys.publicKey },
        now: new Date('2026-07-19T00:00:00.000Z'),
      }).reason;
    },
  },
  {
    id: 'R17-revoked-key-holds', expected: 'trusted_key_revoked', run: () => {
      const artifact = validPlan();
      return evaluatePlanGatePreflight({
        artifact, mode: 'enforce', receipt: receipt(artifact),
        trustedKeys: { 'replay-key': {
          public_key: keys.publicKey,
          metadata: {
            key_id: 'replay-key', algorithm: 'Ed25519',
            not_before: '2026-01-01T00:00:00.000Z', revoked: true,
          },
        } },
      }).reason;
    },
  },
  { id: 'R18-provider-outage-unavailable', expected: 'unavailable', run: () => computePlanConsensus([verdict(null), verdict(null)]) },
  { id: 'R19-split-escalates', expected: 'escalate', run: () => computePlanConsensus([verdict(true), verdict(false)]) },
  { id: 'R20-infrastructure-excluded-from-pass', expected: 'passed', run: () => computePlanConsensus([verdict(true), verdict(true), verdict(null)]) },
  { id: 'R21-call-cap-stops', expected: true, run: () => isBudgetExceeded({ ...baseAccounting, calls_made: 12 }, 0) },
  { id: 'R22-cost-cap-stops', expected: true, run: () => isBudgetExceeded({ ...baseAccounting, estimated_cost_usd: 1.9 }, 0.11) },
];

describe('PCG-008 representative plan replays', () => {
  for (const replay of replays) {
    test(replay.id, () => expect(replay.run()).toEqual(replay.expected));
  }
});
