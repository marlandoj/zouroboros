/**
 * Measured autoloop cost circuit breaker (ZOU-881).
 *
 * Pure cost accounting for the autoloop. The engine's existing breaker
 * (loop.ts shouldContinue -> state.totalCostUSD >= maxCostUSD) was inert
 * because totalCostUSD was never incremented. This module supplies the
 * measured accounting that feeds it, plus fail-closed usage normalization
 * and an idempotent JSONL ledger for spend evidence and restart replay.
 *
 * Design invariants:
 *  - Unknown or malformed usage is NEVER counted as zero (fail closed).
 *  - Each metered action is counted at most once (dedupe by actionId), so
 *    retries and fallbacks that share an id are not double-charged.
 *  - Exact-cap semantics: a run stops AT and beyond the configured ceiling.
 *  - The ledger is the source of truth for restart: replay restores the
 *    cumulative spend and the set of already-counted actions.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

export type MeteredKind = 'attempt' | 'retry' | 'consensus' | 'fallback';

export interface CostEvent {
  /** Stable unique id for the metered action; the dedupe key. */
  actionId: string;
  kind: MeteredKind;
  /** Raw, possibly unknown/malformed usage cost — normalized fail-closed. */
  costUSD: unknown;
  experiment?: number;
  model?: string;
}

export interface CostAccumulator {
  cumulativeUSD: number;
  /** actionIds already counted, so duplicate events are charged once. */
  seen: Set<string>;
}

export interface CostDecision {
  /** false => fail closed; caller must NOT proceed with the metered action. */
  authorized: boolean;
  /** true => actionId already counted; nothing added this call. */
  deduped: boolean;
  /** Normalized cost, or null when unknown/malformed. */
  costUSD: number | null;
  cumulativeUSD: number;
  reason?: string;
}

export interface CostLedgerRecord {
  ts: string;
  type: 'spend' | 'stop';
  actionId?: string;
  kind?: MeteredKind;
  experiment?: number;
  model?: string;
  costUSD?: number | null;
  cumulativeUSD: number;
  reason?: string;
}

/**
 * Fail-closed normalization: only a finite, non-negative number is a known
 * cost. Everything else (undefined, null, NaN, Infinity, negative, non-number,
 * numeric string) returns null so it can never be silently treated as zero.
 */
export function normalizeUsageCost(raw: unknown): number | null {
  if (typeof raw !== 'number') return null;
  if (!Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return raw;
}

export function newAccumulator(): CostAccumulator {
  return { cumulativeUSD: 0, seen: new Set<string>() };
}

/**
 * Record a metered action's cost.
 *  - Missing actionId  -> fail closed (authorized:false).
 *  - Duplicate actionId -> counted once (authorized:true, deduped:true).
 *  - Unknown/malformed  -> fail closed (authorized:false), NOT counted as zero.
 *  - Known cost         -> added to the accumulator.
 * The accumulator is mutated in place only when a known, new cost is added.
 */
export function recordSpend(acc: CostAccumulator, event: CostEvent): CostDecision {
  if (!event.actionId) {
    return {
      authorized: false,
      deduped: false,
      costUSD: null,
      cumulativeUSD: acc.cumulativeUSD,
      reason: 'missing actionId for metered action',
    };
  }
  if (acc.seen.has(event.actionId)) {
    return {
      authorized: true,
      deduped: true,
      costUSD: null,
      cumulativeUSD: acc.cumulativeUSD,
      reason: 'duplicate actionId — already counted',
    };
  }
  const cost = normalizeUsageCost(event.costUSD);
  if (cost === null) {
    return {
      authorized: false,
      deduped: false,
      costUSD: null,
      cumulativeUSD: acc.cumulativeUSD,
      reason: `unknown or malformed usage cost for metered action (${event.kind})`,
    };
  }
  acc.seen.add(event.actionId);
  acc.cumulativeUSD += cost;
  return {
    authorized: true,
    deduped: false,
    costUSD: cost,
    cumulativeUSD: acc.cumulativeUSD,
  };
}

/** Exact-cap: stop AT and beyond the ceiling. */
export function checkCostCeiling(
  cumulativeUSD: number,
  maxCostUSD: number,
): { stop: boolean; reason?: string } {
  if (cumulativeUSD >= maxCostUSD) {
    return {
      stop: true,
      reason: `Cost ceiling reached ($${cumulativeUSD.toFixed(4)} >= $${maxCostUSD})`,
    };
  }
  return { stop: false };
}

/** Append one ledger record (JSONL); creates the parent directory if needed. */
export function appendCostLedger(path: string, record: CostLedgerRecord): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
}

/**
 * Replay a ledger to restore cost state across a restart. Dedupes by actionId
 * so a resumed run never double-counts, and ignores malformed or non-spend
 * lines. A malformed cost in a historical spend line is skipped rather than
 * counted as zero, preserving the fail-closed invariant.
 */
export function replayCostLedger(path: string): CostAccumulator {
  const acc = newAccumulator();
  if (!existsSync(path)) return acc;
  const raw = readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: CostLedgerRecord;
    try {
      rec = JSON.parse(trimmed) as CostLedgerRecord;
    } catch {
      continue;
    }
    if (rec.type !== 'spend' || !rec.actionId) continue;
    if (acc.seen.has(rec.actionId)) continue;
    const cost = normalizeUsageCost(rec.costUSD);
    if (cost === null) continue;
    acc.seen.add(rec.actionId);
    acc.cumulativeUSD += cost;
  }
  return acc;
}

/**
 * Parse a swarm-executor bridge result file's measured cost (ZOU-889).
 *
 * Reads `metrics.totalCostUsd` from the bridge's result JSON and normalizes it
 * fail-closed. Only the claude-code bridge emits `totalCostUsd`; the codex and
 * gemini bridges write a metrics block with `durationMs`/`model` but NO cost,
 * so their results return null (unknown) — never silently 0. Malformed JSON, a
 * missing/ non-object metrics block, or an unknown/negative/non-finite cost all
 * return null. Pure: string in, number|null out (no I/O).
 */
export function parseBridgeCost(resultJson: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const metrics = (parsed as Record<string, unknown>).metrics;
  if (typeof metrics !== 'object' || metrics === null) return null;
  return normalizeUsageCost((metrics as Record<string, unknown>).totalCostUsd);
}
