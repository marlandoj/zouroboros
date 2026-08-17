import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

const DEFAULT_LEASE_MINUTES = 60;
const MIN_LEASE_MINUTES = 5;
const MAX_LEASE_MINUTES = 120;

export interface TicketClaimRecord {
  schema_version: 1;
  ticket_id: string;
  execution_id: string;
  claimed_at: string;
  lease_expires_at: string;
  pid: number;
}

export type TicketClaimResult =
  | { status: "acquired"; record: TicketClaimRecord; claim_path: string }
  | { status: "contended"; record: TicketClaimRecord; claim_path: string; reason: string }
  | { status: "unavailable"; claim_path: string; reason: string };

export interface AcquireTicketClaimOptions {
  stateDir?: string;
  nowMs?: number;
  leaseMs?: number;
  pid?: number;
}

export interface ReconcileTicketClaimsOptions {
  stateDir: string;
  nowMs?: number;
  dryRun?: boolean;
  executionAlive?: (claim: TicketClaimRecord) => boolean;
}

export interface TicketClaimReconcileResult {
  scanned: number;
  reclaimed: string[];
  planned: string[];
  kept: number;
  failed: number;
}

function defaultStateDir(): string {
  return factoryStateRoot();
}

function claimRoot(stateDir: string): string {
  return join(stateDir, "ticket-claims");
}

export function ticketClaimKey(ticketId: string): string {
  const normalized = ticketId.trim();
  if (!normalized) throw new Error("ticket claim requires a Linear ticket_id");
  return createHash("sha256").update(normalized).digest("hex");
}

export function ticketClaimLeaseMs(raw = process.env.SF_TICKET_CLAIM_LEASE_MIN): number {
  const minutes = raw === undefined || raw.trim() === "" ? DEFAULT_LEASE_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < MIN_LEASE_MINUTES || minutes > MAX_LEASE_MINUTES) {
    throw new Error(`SF_TICKET_CLAIM_LEASE_MIN must be between ${MIN_LEASE_MINUTES} and ${MAX_LEASE_MINUTES}`);
  }
  return minutes * 60_000;
}

function validClaim(value: unknown): value is TicketClaimRecord {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<TicketClaimRecord>;
  return claim.schema_version === 1
    && typeof claim.ticket_id === "string"
    && claim.ticket_id.trim() !== ""
    && typeof claim.execution_id === "string"
    && claim.execution_id.trim() !== ""
    && typeof claim.claimed_at === "string"
    && Number.isFinite(Date.parse(claim.claimed_at))
    && typeof claim.lease_expires_at === "string"
    && Number.isFinite(Date.parse(claim.lease_expires_at))
    && typeof claim.pid === "number"
    && Number.isInteger(claim.pid)
    && claim.pid > 0;
}

function readClaim(path: string): TicketClaimRecord {
  const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  if (!validClaim(parsed)) throw new Error("claim owner is invalid");
  if (ticketClaimKey(parsed.ticket_id) !== basename(path)) {
    throw new Error("claim owner ticket_id does not match its storage key");
  }
  return parsed;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function acquireTicketClaim(
  input: { ticket_id: string; execution_id: string },
  options: AcquireTicketClaimOptions = {},
): TicketClaimResult {
  const ticketId = input.ticket_id.trim();
  const executionId = input.execution_id.trim();
  if (!ticketId) throw new Error("ticket claim requires a Linear ticket_id");
  if (!executionId) throw new Error("ticket claim requires an execution_id");

  const stateDir = options.stateDir ?? defaultStateDir();
  const root = claimRoot(stateDir);
  const path = join(root, ticketClaimKey(ticketId));
  const nowMs = options.nowMs ?? Date.now();
  let leaseMs: number;
  try {
    leaseMs = options.leaseMs ?? ticketClaimLeaseMs();
    if (!Number.isFinite(leaseMs) || leaseMs < MIN_LEASE_MINUTES * 60_000 || leaseMs > MAX_LEASE_MINUTES * 60_000) {
      throw new Error(`ticket claim lease must be between ${MIN_LEASE_MINUTES} and ${MAX_LEASE_MINUTES} minutes`);
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        const record = readClaim(path);
        const expired = Date.parse(record.lease_expires_at) <= nowMs;
        return {
          status: "contended",
          record,
          claim_path: path,
          reason: expired ? "expired claim awaits reaper reconciliation" : "ticket already claimed",
        };
      } catch (readError) {
        return {
          status: "unavailable",
          claim_path: path,
          reason: `claim store is unreadable or corrupt: ${readError instanceof Error ? readError.message : String(readError)}`,
        };
      }
    }
    return {
      status: "unavailable",
      claim_path: path,
      reason: `claim store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const record: TicketClaimRecord = {
    schema_version: 1,
    ticket_id: ticketId,
    execution_id: executionId,
    claimed_at: new Date(nowMs).toISOString(),
    lease_expires_at: new Date(nowMs + leaseMs).toISOString(),
    pid: options.pid ?? process.pid,
  };

  try {
    const descriptor = openSync(join(path, "owner.json"), "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(path);
    syncDirectory(root);
    return { status: "acquired", record, claim_path: path };
  } catch (error) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Leaving the directory behind is fail-closed: later cycles cannot acquire it.
    }
    return {
      status: "unavailable",
      claim_path: path,
      reason: `claim could not become durable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function reconcileExpiredTicketClaims(options: ReconcileTicketClaimsOptions): TicketClaimReconcileResult {
  const root = claimRoot(options.stateDir);
  const result: TicketClaimReconcileResult = { scanned: 0, reclaimed: [], planned: [], kept: 0, failed: 0 };
  if (!existsSync(root)) return result;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    result.failed++;
    return result;
  }

  const nowMs = options.nowMs ?? Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      result.failed++;
      continue;
    }
    const path = join(root, entry.name);
    result.scanned++;
    let claim: TicketClaimRecord;
    try {
      claim = readClaim(path);
    } catch {
      result.failed++;
      continue;
    }
    if (Date.parse(claim.lease_expires_at) > nowMs || options.executionAlive?.(claim)) {
      result.kept++;
      continue;
    }
    if (options.dryRun) {
      result.planned.push(claim.ticket_id);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: false });
      result.reclaimed.push(claim.ticket_id);
    } catch {
      result.failed++;
    }
  }
  return result;
}
