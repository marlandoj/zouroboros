#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-010 T5 — Immutable Auto-Merge Audit Trail
 *
 * Every lane evaluation produces a single JSON artifact written to
 * state/auto-merge-audit/{ISO-timestamp}_{pr}.json. The file is written once
 * and never mutated — any subsequent write attempt for the same evaluation
 * key is rejected. Timestamp-scoped keys allow an advisory rehearsal and a
 * live decision for the same PR on the same day without losing either record.
 *
 * Record fields:
 *   pr_ref             — PR number / ref (e.g. "42" or "org/repo#42")
 *   archetype          — SF-011 archetype (e.g. "dependency_bump")
 *   ts                 — ISO timestamp of the merge decision
 *   risk_verdict       — SF-002 RiskVerdict snapshot
 *   scenario_results   — SF-009 ScenarioRunRecord array (3 runs per spec)
 *   snake_pit_report   — SF-010 SnakePitReport
 *   slo_snapshot       — SF-005 SloState | null (null = SF-005 inactive)
 *   merge_result       — outcome of the gh pr merge call
 *   rollback           — populated post-merge if auto-rollback fired
 *
 * CLI:
 *   bun merge-audit-trail.ts list
 *   bun merge-audit-trail.ts show <pr>
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SloState } from "./factory-slo";
import type { RiskVerdict } from "./risk-classifier";
import type { ScenarioRunRecord } from "./scenario-run";
import type { SnakePitReport } from "./snake-pit";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MergeResult {
  sha: string | null;
  method: "squash" | "merge" | "rebase" | "dry-run" | "error";
  duration_ms: number;
  error?: string;
}

export interface RollbackRecord {
  triggered_at: string;
  reason: string;
  slo_breach: string;
  revert_sha: string | null;
  incident_url: string | null;
  revert_error?: string;
}

export interface AutoMergeAudit {
  schema_version: 1;
  pr_ref: string;
  archetype: string;
  ts: string;
  risk_verdict: RiskVerdict;
  scenario_results: ScenarioRunRecord[];
  snake_pit_report: SnakePitReport;
  slo_snapshot: SloState | null;
  consensus_attestation?: {
    path: string;
    ticket: string;
    gate_id: string;
    repository_remote: string;
    base_commit: string;
    implementation_commit: string;
    implementation_diff_sha256: string;
    gate_evidence_hmac: string;
  };
  merge_result: MergeResult;
  rollback?: RollbackRecord;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function auditDir(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "auto-merge-audit");
}

function sanitizePrRef(prRef: string): string {
  return prRef.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64);
}

export function auditFilePath(prRef: string, ts: string, base = PROJECT_DIR): string {
  const timestamp = ts.replace(/[^a-z0-9_-]/gi, "-").slice(0, 48);
  const safe = sanitizePrRef(prRef);
  return join(auditDir(base), `${timestamp}_${safe}.json`);
}

function legacyAuditFilePath(prRef: string, ts: string, base = PROJECT_DIR): string {
  const date = ts.slice(0, 10);
  return join(auditDir(base), `${date}_${sanitizePrRef(prRef)}.json`);
}

// ─── Write (write-once, never mutates) ───────────────────────────────────────

export class AuditWriteError extends Error {}

export function writeAuditRecord(
  record: AutoMergeAudit,
  base = PROJECT_DIR,
): string {
  const path = auditFilePath(record.pr_ref, record.ts, base);
  mkdirSync(auditDir(base), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditWriteError(`unable to write immutable audit record at ${path}: ${detail}`);
  }
  return path;
}

function findAuditRecordPath(prRef: string, ts: string, base: string): string | null {
  const candidates = [
    auditFilePath(prRef, ts, base),
    legacyAuditFilePath(prRef, ts, base),
  ];
  const dir = auditDir(base);
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      candidates.push(join(dir, file));
    }
  }
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    try {
      const record = JSON.parse(readFileSync(path, "utf-8")) as AutoMergeAudit;
      if (record.schema_version === 1 && record.pr_ref === prRef && record.ts === ts) return path;
    } catch {
      // Corrupt and unrelated files are ignored; the caller fails closed if no exact record remains.
    }
  }
  return null;
}

/** Append rollback info to an existing audit record (only mutation allowed). */
export function patchRollback(
  prRef: string,
  ts: string,
  rollback: RollbackRecord,
  base = PROJECT_DIR,
): void {
  const path = findAuditRecordPath(prRef, ts, base);
  if (!path) throw new AuditWriteError(`audit record not found for ${prRef} at ${ts}`);
  const record = JSON.parse(readFileSync(path, "utf-8")) as AutoMergeAudit;
  if (record.rollback) {
    throw new AuditWriteError(`rollback already recorded for ${prRef} — cannot overwrite`);
  }
  record.rollback = rollback;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function listAuditRecords(base = PROJECT_DIR): AutoMergeAudit[] {
  const dir = auditDir(base);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const records: AutoMergeAudit[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8")) as AutoMergeAudit;
      if (raw.schema_version === 1) records.push(raw);
    } catch {
      // corrupt file — skip
    }
  }
  return records.sort((a, b) => {
    const byTime = Date.parse(a.ts) - Date.parse(b.ts);
    return Number.isFinite(byTime) && byTime !== 0 ? byTime : a.pr_ref.localeCompare(b.pr_ref);
  });
}

export function findAuditRecord(prRef: string, base = PROJECT_DIR, ts?: string): AutoMergeAudit | null {
  const records = listAuditRecords(base);
  const matching = records.filter((record) => record.pr_ref === prRef && (!ts || record.ts === ts));
  return matching.at(-1) ?? null;
}

/** Count consecutive rollbacks at the tail of the audit log (circuit breaker input). */
export function consecutiveRollbacks(base = PROJECT_DIR): number {
  const records = listAuditRecords(base);
  let count = 0;
  for (const rec of [...records].reverse()) {
    if (rec.rollback) count++;
    else break;
  }
  return count;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    const records = listAuditRecords();
    if (!records.length) { console.log("No auto-merge audit records."); process.exit(0); }
    for (const r of records) {
      const status = r.rollback ? "ROLLED_BACK" : "merged";
      console.log(`${r.ts.slice(0, 19)}  PR#${r.pr_ref}  ${r.archetype}  ${status}  merge_sha=${r.merge_result.sha ?? "n/a"}`);
    }
  } else if (cmd === "show") {
    if (!arg) { console.error("Usage: show <pr_ref>"); process.exit(1); }
    const rec = findAuditRecord(arg);
    if (!rec) { console.error(`No audit record for PR '${arg}'`); process.exit(1); }
    console.log(JSON.stringify(rec, null, 2));
  } else {
    console.log("Usage: bun merge-audit-trail.ts <list|show> [pr_ref]");
    process.exit(0);
  }
}
