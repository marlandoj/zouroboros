import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const LEDGER_SCHEMA_VERSION = 2 as const;
const ANCHOR_SCHEMA_VERSION = 1 as const;
const GENESIS_HASH = "0".repeat(64);
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export type AuditKind =
  | "genesis"
  | "verdict"
  | "bypass"
  | "blocked-tool-attempt"
  | "autonomy-decision"
  | "authorization-consumed";

export interface AuditRecord {
  schema_version?: number;
  ts: string;
  kind: AuditKind;
  payload: unknown;
  idempotency_key?: string;
  prev_hash: string;
  this_hash: string;
}

interface AnchorRecord {
  schema_version: typeof ANCHOR_SCHEMA_VERSION;
  ts: string;
  audit_path: string;
  record_count: number;
  head_hash: string;
  previous_anchor_hash: string;
  mac: string;
}

export interface LedgerPaths {
  audit: string;
  anchor: string;
  anchorKey: string;
  lock: string;
}

export interface VerifyReport {
  ok: boolean;
  chain_ok: boolean;
  anchor_ok: boolean;
  count: number;
  first_broken: number | null;
  blocked_attempts: number;
  bypass_count: number;
  verdict_count: number;
  autonomy_decisions: number;
  authorization_consumptions: number;
  head_hash: string;
  anchor_error?: string;
}

export function ledgerPaths(): LedgerPaths {
  const home = process.env.HOME || "/root";
  const audit = process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH
    || path.join(home, ".zouroboros", "governance-audit.log");
  return {
    audit,
    anchor: process.env.ZOUROBOROS_GOVERNANCE_ANCHOR_PATH
      || path.join(home, ".local", "state", "zouroboros", "governance-anchor.log"),
    anchorKey: process.env.ZOUROBOROS_GOVERNANCE_ANCHOR_KEY_PATH
      || path.join(home, ".config", "zouroboros", "governance-anchor.key"),
    lock: `${audit}.lock`,
  };
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeRecordHash(record: AuditRecord): string {
  return sha256(canonicalStringify({
    schema_version: record.schema_version,
    ts: record.ts,
    kind: record.kind,
    payload: record.payload,
    idempotency_key: record.idempotency_key,
    prev_hash: record.prev_hash,
  }));
}

function computeLegacyRecordHash(record: AuditRecord): string {
  return sha256(JSON.stringify({
    ts: record.ts,
    kind: record.kind,
    payload: record.payload,
    prev_hash: record.prev_hash,
  }));
}

function sleep(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function acquireLock(lockPath: string): number {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      return descriptor;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error(`governance ledger lock timeout: ${lockPath}`);
}

function withLedgerLock<T>(operation: (paths: LedgerPaths) => T): T {
  const paths = ledgerPaths();
  const descriptor = acquireLock(paths.lock);
  try {
    return operation(paths);
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(paths.lock);
    } catch {
      // A missing lock after the descriptor closes is harmless.
    }
  }
}

function parseJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const contents = fs.readFileSync(filePath, "utf8").trim();
  if (!contents) return [];
  return contents.split("\n").map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`invalid JSON at ${filePath}:${index + 1}`);
    }
  });
}

function appendDurably(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureAnchorKey(keyPath: string): Buffer {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    const descriptor = fs.openSync(keyPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, randomBytes(32).toString("base64"));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
  }
  const stat = fs.statSync(keyPath);
  if ((stat.mode & 0o077) !== 0) throw new Error(`anchor key permissions must be 0600: ${keyPath}`);
  const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
  if (key.length < 32) throw new Error(`anchor key is too short: ${keyPath}`);
  return key;
}

function anchorMaterial(record: Omit<AnchorRecord, "mac">): string {
  return canonicalStringify(record);
}

function anchorHash(record: AnchorRecord): string {
  return sha256(canonicalStringify(record));
}

function anchorHead(paths: LedgerPaths, recordCount: number, headHash: string): void {
  const key = ensureAnchorKey(paths.anchorKey);
  const anchors = parseJsonLines<AnchorRecord>(paths.anchor);
  const previous = anchors.at(-1);
  if (previous?.record_count === recordCount && previous.head_hash === headHash) return;
  const unsigned: Omit<AnchorRecord, "mac"> = {
    schema_version: ANCHOR_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    audit_path: path.resolve(paths.audit),
    record_count: recordCount,
    head_hash: headHash,
    previous_anchor_hash: previous ? anchorHash(previous) : GENESIS_HASH,
  };
  const record: AnchorRecord = {
    ...unsigned,
    mac: createHmac("sha256", key).update(anchorMaterial(unsigned)).digest("hex"),
  };
  appendDurably(paths.anchor, record);
}

function ensureGenesis(paths: LedgerPaths): AuditRecord[] {
  const records = parseJsonLines<AuditRecord>(paths.audit);
  if (records.length > 0) return records;
  const genesis: AuditRecord = {
    schema_version: LEDGER_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    kind: "genesis",
    payload: { note: "zouroboros-governance audit log initialized" },
    prev_hash: GENESIS_HASH,
    this_hash: "",
  };
  genesis.this_hash = computeRecordHash(genesis);
  appendDurably(paths.audit, genesis);
  return [genesis];
}

function appendRecordLocked(
  paths: LedgerPaths,
  records: AuditRecord[],
  kind: AuditKind,
  payload: unknown,
  idempotencyKey?: string,
): AuditRecord {
  const record: AuditRecord = {
    schema_version: LEDGER_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    kind,
    payload,
    idempotency_key: idempotencyKey,
    prev_hash: records.at(-1)?.this_hash || GENESIS_HASH,
    this_hash: "",
  };
  record.this_hash = computeRecordHash(record);
  appendDurably(paths.audit, record);
  records.push(record);
  return record;
}

export function appendAuditRecord(
  kind: AuditKind,
  payload: unknown,
  options: { idempotencyKey?: string } = {},
): { record: AuditRecord; appended: boolean } {
  return withLedgerLock((paths) => {
    const records = ensureGenesis(paths);
    if (options.idempotencyKey) {
      const existing = records.find((record) => record.idempotency_key === options.idempotencyKey);
      if (existing) {
        anchorHead(paths, records.length, existing === records.at(-1) ? existing.this_hash : records.at(-1)!.this_hash);
        return { record: existing, appended: false };
      }
    }
    const record = appendRecordLocked(paths, records, kind, payload, options.idempotencyKey);
    anchorHead(paths, records.length, record.this_hash);
    return { record, appended: true };
  });
}

export interface AuthorizationReservation {
  request_fingerprint: string;
  approving_authority: string;
  nonce: string;
}

export interface RelatedAuthorizationRecord {
  kind: Exclude<AuditKind, "authorization-consumed">;
  payload: unknown;
  idempotencyKey?: string;
}

export function reserveAuthorizationUse(
  reservation: AuthorizationReservation,
  relatedRecord?: RelatedAuthorizationRecord,
): { consumption: AuditRecord; related?: AuditRecord } {
  return withLedgerLock((paths) => {
    const records = ensureGenesis(paths);
    const alreadyConsumed = records.some((record) => {
      if (
        !["authorization-consumed", "bypass"].includes(record.kind)
        || !record.payload
        || typeof record.payload !== "object"
      ) return false;
      return (record.payload as { request_fingerprint?: unknown }).request_fingerprint
        === reservation.request_fingerprint;
    });
    if (alreadyConsumed) {
      throw new Error(`single-use authorization was already consumed: ${reservation.request_fingerprint}`);
    }

    const consumption = appendRecordLocked(
      paths,
      records,
      "authorization-consumed",
      reservation,
      `authorization-consumed:${reservation.request_fingerprint}`,
    );
    const related = relatedRecord
      ? appendRecordLocked(
        paths,
        records,
        relatedRecord.kind,
        relatedRecord.payload,
        relatedRecord.idempotencyKey,
      )
      : undefined;
    anchorHead(paths, records.length, records.at(-1)!.this_hash);
    return { consumption, related };
  });
}

function verifyAnchor(paths: LedgerPaths, recordCount: number, headHash: string): { ok: boolean; error?: string } {
  try {
    const key = ensureAnchorKey(paths.anchorKey);
    const anchors = parseJsonLines<AnchorRecord>(paths.anchor);
    if (anchors.length === 0) return { ok: false, error: "detached anchor is missing" };
    let previousHash = GENESIS_HASH;
    for (const [index, record] of anchors.entries()) {
      if (record.schema_version !== ANCHOR_SCHEMA_VERSION) {
        return { ok: false, error: `unsupported anchor schema at index ${index}` };
      }
      if (record.previous_anchor_hash !== previousHash) {
        return { ok: false, error: `broken anchor chain at index ${index}` };
      }
      const { mac, ...unsigned } = record;
      const expected = createHmac("sha256", key).update(anchorMaterial(unsigned)).digest("hex");
      const actualBuffer = Buffer.from(mac, "hex");
      const expectedBuffer = Buffer.from(expected, "hex");
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        return { ok: false, error: `invalid anchor MAC at index ${index}` };
      }
      previousHash = anchorHash(record);
    }
    const latest = anchors.at(-1)!;
    if (latest.audit_path !== path.resolve(paths.audit)) return { ok: false, error: "anchor audit path mismatch" };
    if (latest.record_count !== recordCount) return { ok: false, error: "anchor record count mismatch" };
    if (latest.head_hash !== headHash) return { ok: false, error: "anchor head hash mismatch" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyLedger(): VerifyReport {
  const paths = ledgerPaths();
  if (!fs.existsSync(paths.audit)) {
    return {
      ok: false,
      chain_ok: true,
      anchor_ok: false,
      count: 0,
      first_broken: null,
      blocked_attempts: 0,
      bypass_count: 0,
      verdict_count: 0,
      autonomy_decisions: 0,
      authorization_consumptions: 0,
      head_hash: GENESIS_HASH,
      anchor_error: "audit log is missing and therefore cannot be integrity-valid evidence",
    };
  }

  let records: AuditRecord[];
  try {
    records = parseJsonLines<AuditRecord>(paths.audit);
  } catch (error) {
    return {
      ok: false,
      chain_ok: false,
      anchor_ok: false,
      count: 0,
      first_broken: 0,
      blocked_attempts: 0,
      bypass_count: 0,
      verdict_count: 0,
      autonomy_decisions: 0,
      authorization_consumptions: 0,
      head_hash: GENESIS_HASH,
      anchor_error: error instanceof Error ? error.message : String(error),
    };
  }

  let previous = GENESIS_HASH;
  let firstBroken: number | null = null;
  let blockedAttempts = 0;
  let bypassCount = 0;
  let verdictCount = 0;
  let autonomyDecisions = 0;
  let authorizationConsumptions = 0;
  for (const [index, record] of records.entries()) {
    if (record.prev_hash !== previous) firstBroken ??= index;
    const expected = record.schema_version === undefined
      ? computeLegacyRecordHash(record)
      : computeRecordHash(record);
    if (record.this_hash !== expected) firstBroken ??= index;
    if (record.kind === "blocked-tool-attempt") blockedAttempts += 1;
    if (record.kind === "bypass") bypassCount += 1;
    if (record.kind === "verdict") verdictCount += 1;
    if (record.kind === "autonomy-decision") autonomyDecisions += 1;
    if (record.kind === "authorization-consumed") authorizationConsumptions += 1;
    previous = record.this_hash;
  }
  const headHash = records.at(-1)?.this_hash || GENESIS_HASH;
  const anchor = verifyAnchor(paths, records.length, headHash);
  return {
    ok: firstBroken === null && anchor.ok,
    chain_ok: firstBroken === null,
    anchor_ok: anchor.ok,
    count: records.length,
    first_broken: firstBroken,
    blocked_attempts: blockedAttempts,
    bypass_count: bypassCount,
    verdict_count: verdictCount,
    autonomy_decisions: autonomyDecisions,
    authorization_consumptions: authorizationConsumptions,
    head_hash: headHash,
    anchor_error: anchor.error,
  };
}

export function anchorCurrentLedger(): VerifyReport {
  withLedgerLock((paths) => {
    const records = ensureGenesis(paths);
    anchorHead(paths, records.length, records.at(-1)!.this_hash);
  });
  return verifyLedger();
}

export function readAuditRecords(): AuditRecord[] {
  return parseJsonLines<AuditRecord>(ledgerPaths().audit);
}

export function tailAuditRecords(limit: number): AuditRecord[] {
  return readAuditRecords().slice(-Math.max(0, limit));
}
