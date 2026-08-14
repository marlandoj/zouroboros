import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { validPlan } from './fixtures.js';
import { hashPlanArtifact } from '../canonicalize.js';
import { evaluatePlanGatePreflight } from '../preflight.js';
import { signApprovalReceipt, verifyApprovalReceipt } from '../receipt.js';
import type { ApprovalReceipt } from '../types.js';

const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});

function unsignedReceipt(): ApprovalReceipt {
  return {
    receipt_type: 'approval',
    artifact_sha256: hashPlanArtifact(validPlan()),
    gate_run_ids: ['gate-1'],
    decision: 'accepted',
    actor: {
      id: 'operator-1',
      source: 'test-auth',
      authorization: 'project-owner',
    },
    timestamp: '2026-07-17T20:00:00.000Z',
    expiry: '2026-07-18T20:00:00.000Z',
    signed: false,
    enforcement_eligible: false,
    revision: 1,
  };
}

describe('receipt signing and verification', () => {
  test('accepts a valid artifact-bound Ed25519 receipt', () => {
    const receipt = signApprovalReceipt(unsignedReceipt(), {
      keyId: 'key-1',
      privateKey: keys.privateKey,
    });
    const result = verifyApprovalReceipt(receipt, {
      artifactSha256: receipt.artifact_sha256,
      revision: 1,
      mode: 'enforce',
      trustedKeys: { 'key-1': keys.publicKey },
      now: new Date('2026-07-17T21:00:00.000Z'),
    });
    expect(result.valid).toBe(true);
    expect(result.enforcement_eligible).toBe(true);
  });

  test('rejects stale artifacts, expired receipts, and revoked keys', () => {
    const receipt = signApprovalReceipt(unsignedReceipt(), {
      keyId: 'key-1',
      privateKey: keys.privateKey,
    });
    expect(verifyApprovalReceipt(receipt, {
      artifactSha256: '0'.repeat(64), mode: 'enforce', trustedKeys: { 'key-1': keys.publicKey },
    }).reason).toBe('artifact_hash_mismatch');
    expect(verifyApprovalReceipt(receipt, {
      artifactSha256: receipt.artifact_sha256,
      mode: 'enforce',
      trustedKeys: { 'key-1': keys.publicKey },
      now: new Date('2026-07-19T00:00:00.000Z'),
    }).reason).toBe('receipt_expired');
    expect(verifyApprovalReceipt(receipt, {
      artifactSha256: receipt.artifact_sha256,
      mode: 'enforce',
      trustedKeys: {
        'key-1': {
          public_key: keys.publicKey,
          metadata: {
            key_id: 'key-1', algorithm: 'Ed25519',
            not_before: '2026-07-01T00:00:00.000Z', revoked: true,
          },
        },
      },
      now: new Date('2026-07-17T21:00:00.000Z'),
    }).reason).toBe('trusted_key_revoked');
  });

  test('fails closed when trust material is absent or malformed', () => {
    const receipt = signApprovalReceipt(unsignedReceipt(), {
      keyId: 'key-1', privateKey: keys.privateKey,
    });
    const base = {
      artifactSha256: receipt.artifact_sha256,
      mode: 'enforce' as const,
      now: new Date('2026-07-17T21:00:00.000Z'),
    };
    expect(verifyApprovalReceipt(receipt, base).reason).toBe('trusted_key_missing');
    expect(verifyApprovalReceipt(receipt, {
      ...base, trustedKeys: { 'key-1': 'not-a-public-key' },
    }).reason).toBe('trust_material_invalid');
  });
});

describe('evaluatePlanGatePreflight', () => {
  test('holds mandatory plans in enforcement without a receipt', () => {
    const result = evaluatePlanGatePreflight({ artifact: validPlan(), mode: 'enforce' });
    expect(result.required).toBe(true);
    expect(result.action).toBe('hold');
    expect(result.reason).toBe('approval_receipt_required');
  });

  test('reports would-hold without blocking in shadow mode', () => {
    const result = evaluatePlanGatePreflight({ artifact: validPlan(), mode: 'shadow' });
    expect(result.action).toBe('proceed');
    expect(result.would_hold).toBe(true);
    expect(result.audit_event).toBe('plan_gate_shadow_hold');
  });

  test('proceeds with a valid enforcement receipt', () => {
    const receipt = signApprovalReceipt(unsignedReceipt(), {
      keyId: 'key-1', privateKey: keys.privateKey,
    });
    const result = evaluatePlanGatePreflight({
      artifact: validPlan(),
      mode: 'enforce',
      receipt,
      trustedKeys: { 'key-1': keys.publicKey },
      now: new Date('2026-07-17T21:00:00.000Z'),
    });
    expect(result.action).toBe('proceed');
    expect(result.would_hold).toBe(false);
  });
});
