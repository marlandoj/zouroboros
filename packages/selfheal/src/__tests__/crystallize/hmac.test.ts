/**
 * Hmac approval-token coverage — FX-15, FX-16.
 *
 * Asserts:
 *   • happy path round-trip (sign then verify with same inputs ⇒ ok=true)
 *   • tampered token ⇒ ok=false reason=mismatch (timingSafeEqual)
 *   • expired token ⇒ ok=false reason=expired
 *   • missing secret ⇒ verify returns missing-secret (no throw)
 *   • weak secret ⇒ signToken throws ApprovalSecretWeakError
 *   • malformed hex ⇒ ok=false reason=malformed
 *   • token_prefix_8 always populated, even on failure paths
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  signToken,
  verifyToken,
  tokenPrefix8,
  canonicalMessage,
  ApprovalSecretWeakError,
} from '../../crystallize/hmac.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

const ENV_KEY = 'CRYSTALLIZE_APPROVAL_SECRET';
let savedSecret: string | undefined;

describe('crystallize/hmac (FX-15, FX-16)', () => {
  beforeEach(() => {
    savedSecret = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedSecret;
  });

  test('canonicalMessage is delimited and stable', () => {
    const m = canonicalMessage({
      id: 'a',
      created_at: 42,
      candidate_path: '/tmp/x',
    });
    expect(m).toBe('a\n42\n/tmp/x');
  });

  test('happy path: sign then verify returns ok=true', () => {
    process.env[ENV_KEY] = 'a'.repeat(32);
    const inputs = {
      id: '00000000-0000-0000-0000-000000000099',
      created_at: 1700000000,
      candidate_path: '/tmp/Skills/_candidates/x',
    };
    const tok = signToken(inputs);
    const v = verifyToken(inputs, tok, 1700000001);
    expect(v.ok).toBe(true);
    expect(v.token_prefix_8).toBe(tok.slice(0, 8));
  });

  test('FX-15: tampered token ⇒ mismatch', () => {
    const fx = FX('FX-15-hmac-tampered-token');
    process.env[ENV_KEY] = fx.input.secret_bytes;

    const inputs = {
      id: fx.input.id,
      created_at: fx.input.created_at,
      candidate_path: fx.input.candidate_path,
    };
    const valid = signToken(inputs);
    // Flip last hex char (preserving valid hex shape).
    const last = valid.slice(-1);
    const flipped = last === '0' ? '1' : '0';
    const tampered = valid.slice(0, -1) + flipped;
    const v = verifyToken(inputs, tampered, fx.input.created_at + 1);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('mismatch');
    expect(v.token_prefix_8).toMatch(/^[0-9a-f]{8}$/);
  });

  test('FX-16: token expired by ttl ⇒ reason=expired', () => {
    const fx = FX('FX-16-hmac-expired-token');
    process.env[ENV_KEY] = fx.input.secret_bytes;

    const inputs = {
      id: fx.input.id,
      created_at: fx.input.created_at,
      candidate_path: fx.input.candidate_path,
    };
    const tok = signToken(inputs);
    const v = verifyToken(inputs, tok, fx.input.now_seconds);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('expired');
  });

  test('missing secret ⇒ verify returns reason=missing-secret', () => {
    delete process.env[ENV_KEY];
    const v = verifyToken(
      { id: 'a', created_at: 1, candidate_path: '/x' },
      'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdd',
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('missing-secret');
  });

  test('weak secret ⇒ signToken throws ApprovalSecretWeakError', () => {
    process.env[ENV_KEY] = 'short';
    expect(() =>
      signToken({ id: 'a', created_at: 1, candidate_path: '/x' }),
    ).toThrow(ApprovalSecretWeakError);
  });

  test('malformed token ⇒ reason=malformed, token_prefix_8 still set', () => {
    process.env[ENV_KEY] = 'a'.repeat(32);
    const v = verifyToken(
      { id: 'a', created_at: 1, candidate_path: '/x' },
      'not-hex-at-all-123',
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('malformed');
    expect(v.token_prefix_8).toBe('not-hex-');
  });

  test('tokenPrefix8 trims to first 8 chars', () => {
    expect(tokenPrefix8('deadbeefcafebabe')).toBe('deadbeef');
    expect(tokenPrefix8('')).toBe('');
  });
});
