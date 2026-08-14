import { createPublicKey, verify as verifySignature } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalStringify,
  readAuditRecords,
  reserveAuthorizationUse,
  verifyLedger,
  type RelatedAuthorizationRecord,
} from "./governance-ledger";

export interface AuthorizationEvidence {
  schema_version: 1;
  actor: string;
  action: string;
  resource: string;
  request_fingerprint: string;
  scope: string;
  issued_at: string;
  expires_at: string;
  revoked: boolean;
  approving_authority: string;
  nonce: string;
  signature: string;
}

export interface AuthorizationExpectation {
  actor: string;
  action: string;
  resource: string;
  requestFingerprint: string;
  scope?: string;
}

export interface AuthorizationResult {
  valid: boolean;
  reason: string;
  authority?: string;
}

type AuthorityRegistry = Record<string, { algorithm: "ed25519"; public_key_pem: string; revoked?: boolean }>;

export function authorityRegistryPath(): string {
  const home = process.env.HOME || "/root";
  return process.env.ZOUROBOROS_APPROVAL_KEYS_PATH
    || path.join(home, ".config", "zouroboros", "approval-authorities.json");
}

export function authorizationMaterial(evidence: AuthorizationEvidence): string {
  const { signature: _signature, ...signed } = evidence;
  return canonicalStringify(signed);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseAuthorizationEvidence(value: unknown): AuthorizationEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<AuthorizationEvidence>;
  if (
    candidate.schema_version !== 1
    || !isNonEmpty(candidate.actor)
    || !isNonEmpty(candidate.action)
    || !isNonEmpty(candidate.resource)
    || !isNonEmpty(candidate.request_fingerprint)
    || !isNonEmpty(candidate.scope)
    || !isNonEmpty(candidate.issued_at)
    || !isNonEmpty(candidate.expires_at)
    || typeof candidate.revoked !== "boolean"
    || !isNonEmpty(candidate.approving_authority)
    || !isNonEmpty(candidate.nonce)
    || !isNonEmpty(candidate.signature)
  ) return null;
  return candidate as AuthorizationEvidence;
}

function loadRegistry(): AuthorityRegistry {
  const registryPath = authorityRegistryPath();
  if (!fs.existsSync(registryPath)) throw new Error(`approval authority registry missing: ${registryPath}`);
  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("approval authority registry must be a JSON object");
  }
  return parsed as AuthorityRegistry;
}

function alreadyConsumed(requestFingerprint: string): boolean {
  return readAuditRecords().some((record) => {
    if (
      !["authorization-consumed", "bypass"].includes(record.kind)
      || !record.payload
      || typeof record.payload !== "object"
    ) return false;
    return (record.payload as { request_fingerprint?: unknown }).request_fingerprint === requestFingerprint;
  });
}

export function verifyAuthorization(
  evidenceValue: unknown,
  expected: AuthorizationExpectation,
  options: { now?: Date; requireUnused?: boolean } = {},
): AuthorizationResult {
  const evidence = parseAuthorizationEvidence(evidenceValue);
  if (!evidence) return { valid: false, reason: "authorization evidence is malformed or incomplete" };
  if (evidence.revoked) return { valid: false, reason: "authorization evidence is revoked" };
  if (evidence.actor !== expected.actor) return { valid: false, reason: "actor binding mismatch" };
  if (evidence.action !== expected.action) return { valid: false, reason: "action binding mismatch" };
  if (evidence.resource !== expected.resource) return { valid: false, reason: "resource binding mismatch" };
  if (evidence.request_fingerprint !== expected.requestFingerprint) {
    return { valid: false, reason: "request fingerprint binding mismatch" };
  }
  if (expected.scope !== undefined && evidence.scope !== expected.scope) {
    return { valid: false, reason: "scope binding mismatch" };
  }

  const now = (options.now || new Date()).getTime();
  const issuedAt = Date.parse(evidence.issued_at);
  const expiresAt = Date.parse(evidence.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "authorization timestamps are invalid" };
  }
  if (issuedAt > now) return { valid: false, reason: "authorization is not yet valid" };
  if (expiresAt <= now) return { valid: false, reason: "authorization is expired" };
  if (expiresAt <= issuedAt) return { valid: false, reason: "authorization expiry precedes issuance" };

  const ledger = verifyLedger();
  if (!ledger.ok) {
    return {
      valid: false,
      reason: `governance ledger integrity check failed: ${ledger.anchor_error || `broken record at index ${ledger.first_broken}`}`,
    };
  }
  if (options.requireUnused && alreadyConsumed(evidence.request_fingerprint)) {
    return { valid: false, reason: "single-use authorization was already consumed" };
  }

  try {
    const authority = loadRegistry()[evidence.approving_authority];
    if (!authority || authority.algorithm !== "ed25519" || authority.revoked) {
      return { valid: false, reason: "approving authority is unknown or revoked" };
    }
    const valid = verifySignature(
      null,
      Buffer.from(authorizationMaterial(evidence)),
      createPublicKey(authority.public_key_pem),
      Buffer.from(evidence.signature, "base64"),
    );
    return valid
      ? { valid: true, reason: "authorization signature and bindings are valid", authority: evidence.approving_authority }
      : { valid: false, reason: "authorization signature is invalid" };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function consumeAuthorization(
  evidence: AuthorizationEvidence,
  relatedRecord?: RelatedAuthorizationRecord,
): ReturnType<typeof reserveAuthorizationUse> {
  return reserveAuthorizationUse({
    request_fingerprint: evidence.request_fingerprint,
    approving_authority: evidence.approving_authority,
    nonce: evidence.nonce,
  }, relatedRecord);
}

export function readAuthorizationFile(filePath: string): AuthorizationEvidence {
  const parsed = parseAuthorizationEvidence(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  if (!parsed) throw new Error(`invalid authorization evidence: ${filePath}`);
  return parsed;
}
