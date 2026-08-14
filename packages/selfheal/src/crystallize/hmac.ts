/**
 * hmac.ts — HMAC-SHA256 sign/verify for skill crystallization approval tokens.
 *
 * Token = HMAC-SHA256(id || "\n" || created_at || "\n" || candidate_path,
 *                     key=CRYSTALLIZE_APPROVAL_SECRET)
 *
 * Why a delimiter ("\n"): without it, ("a", "bcd") and ("ab", "cd") would
 * collide. Newline is the lowest-effort separator that can't appear in any
 * legitimate id, candidate_path component, or numeric created_at.
 *
 * Verification uses crypto.timingSafeEqual to defeat timing oracles.
 *
 * Per seed AC + Sec Eng F1–F6:
 *   • Secret read from env at call time (never imported); ≥32 random bytes.
 *   • Tokens expire at created_at + APPROVAL_TTL_DAYS (caller checks).
 *   • One-shot use enforced by caller (DB approval_status transition).
 *   • CLI logs only first 8 chars of token (token_prefix_8) — never the full
 *     value. The DB column `approval_token_prefix_8` mirrors this.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { APPROVAL_TTL_DAYS } from './types.js';

const SECRET_ENV_VAR = 'CRYSTALLIZE_APPROVAL_SECRET';
const MIN_SECRET_BYTES = 32;
const SEPARATOR = '\n';

export class ApprovalSecretMissingError extends Error {
  constructor() {
    super(
      `${SECRET_ENV_VAR} environment variable is not set. ` +
        `Generate ≥${MIN_SECRET_BYTES} random bytes and store in Zo Secrets.`,
    );
    this.name = 'ApprovalSecretMissingError';
  }
}

export class ApprovalSecretWeakError extends Error {
  constructor(observedBytes: number) {
    super(
      `${SECRET_ENV_VAR} is too short (${observedBytes} bytes). ` +
        `Minimum: ${MIN_SECRET_BYTES} bytes.`,
    );
    this.name = 'ApprovalSecretWeakError';
  }
}

function loadSecret(): Buffer {
  const raw = process.env[SECRET_ENV_VAR];
  if (!raw || raw.length === 0) throw new ApprovalSecretMissingError();
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length < MIN_SECRET_BYTES) {
    throw new ApprovalSecretWeakError(buf.length);
  }
  return buf;
}

export interface TokenInputs {
  /** Crystallization id (UUID). */
  id: string;
  /** Unix seconds when the candidate was created. */
  created_at: number;
  /** Filesystem path to the drafted candidate. */
  candidate_path: string;
}

/** Canonical message that gets HMACed — exposed for test assertions. */
export function canonicalMessage(t: TokenInputs): string {
  return [t.id, String(t.created_at), t.candidate_path].join(SEPARATOR);
}

/** Sign — returns lowercase hex digest. */
export function signToken(t: TokenInputs): string {
  const key = loadSecret();
  return createHmac('sha256', key).update(canonicalMessage(t)).digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'missing-secret' | 'malformed' | 'mismatch' | 'expired';
  token_prefix_8: string;
}

/**
 * Verify a candidate token against the canonical inputs.
 *
 * Returns ok=true ONLY if the HMAC matches AND the token has not expired.
 * Always returns a `token_prefix_8` so CLI invocation logging can record the
 * attempted token without leaking the full value.
 *
 * Caller must additionally check the DB `approval_status` to enforce one-shot
 * use; this function is stateless.
 */
export function verifyToken(
  t: TokenInputs,
  presentedHex: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const token_prefix_8 = (presentedHex || '').slice(0, 8);

  if (!presentedHex || !/^[0-9a-f]+$/i.test(presentedHex)) {
    return { ok: false, reason: 'malformed', token_prefix_8 };
  }

  let expected: string;
  try {
    expected = signToken(t);
  } catch (err) {
    if (err instanceof ApprovalSecretMissingError) {
      return { ok: false, reason: 'missing-secret', token_prefix_8 };
    }
    throw err;
  }

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(presentedHex.toLowerCase(), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'mismatch', token_prefix_8 };
  }

  const expiresAt = t.created_at + APPROVAL_TTL_DAYS * 86_400;
  if (nowSeconds >= expiresAt) {
    return { ok: false, reason: 'expired', token_prefix_8 };
  }

  return { ok: true, token_prefix_8 };
}

/** Convenience for storing the prefix in DB (`approval_token_prefix_8`). */
export function tokenPrefix8(hex: string): string {
  return (hex || '').slice(0, 8);
}
