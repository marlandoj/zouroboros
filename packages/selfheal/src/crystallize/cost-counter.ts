/**
 * cost-counter.ts — Daily LLM cost cap (monotonic, idempotent).
 *
 * Per seed AC: "Daily LLM cost cap: monotonic counter in memory_metrics keyed
 * by (metric, day); breach → scan exits, no candidates emailed."
 *
 * Implementation:
 *   • One row per day in the existing `memory_metrics` table (key UNIQUE).
 *   • Metric name pattern: `crystallize.cost.usd.YYYY-MM-DD` (UTC date).
 *   • Cap default $1.00/day; per-run cap default $0.10 enforced by caller.
 *   • Concurrent cron + hook writers: bun:sqlite WAL serializes upserts via
 *     ON CONFLICT(metric) DO UPDATE … memory_metrics.value + excluded.value.
 *
 * The DB connection is injected by the caller — this module never opens its
 * own connection so unit tests can inject `:memory:` and the production
 * runtime can reuse the existing memory db handle.
 */

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export const DEFAULT_DAILY_CAP_USD = 1.0;
export const DEFAULT_PER_RUN_CAP_USD = 0.1;

/** UTC date stamp (YYYY-MM-DD) for a given epoch-seconds value. */
export function dayKey(nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 10);
}

export function metricNameFor(day: string): string {
  return `crystallize.cost.usd.${day}`;
}

/** Ensure the memory_metrics table exists; idempotent. */
export function ensureMetricsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_metrics (
      id TEXT PRIMARY KEY,
      metric TEXT NOT NULL UNIQUE,
      value REAL NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
}

/** Read today's spend in USD. Missing row → 0. */
export function readDailySpend(
  db: Database,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  ensureMetricsTable(db);
  const metric = metricNameFor(dayKey(nowSeconds));
  const row = db
    .prepare('SELECT value FROM memory_metrics WHERE metric = ?')
    .get(metric) as { value: number } | undefined;
  return row?.value ?? 0;
}

/**
 * Reserve `amountUsd` against today's cap. Atomic check-then-add — if the
 * reservation would exceed the cap, returns ok=false without mutating state.
 *
 * Use this BEFORE invoking the LLM; on actual cost return (which may differ),
 * call recordSpend() with the observed delta.
 */
export interface ReserveResult {
  ok: boolean;
  spent_today_before: number;
  spent_today_after: number;
  cap_usd: number;
  reason?: 'cap_exceeded';
}

export function tryReserve(
  db: Database,
  amountUsd: number,
  cap: number = DEFAULT_DAILY_CAP_USD,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ReserveResult {
  ensureMetricsTable(db);
  const day = dayKey(nowSeconds);
  const metric = metricNameFor(day);

  return db.transaction(() => {
    const before =
      (
        db
          .prepare('SELECT value FROM memory_metrics WHERE metric = ?')
          .get(metric) as { value: number } | undefined
      )?.value ?? 0;

    const after = +(before + amountUsd).toFixed(6);
    if (after > cap) {
      return {
        ok: false,
        spent_today_before: before,
        spent_today_after: before,
        cap_usd: cap,
        reason: 'cap_exceeded',
      } as const;
    }

    db.prepare(
      `INSERT INTO memory_metrics (id, metric, value, updated_at)
       VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(metric) DO UPDATE SET
         value = memory_metrics.value + excluded.value,
         updated_at = strftime('%s','now')`,
    ).run(randomUUID(), metric, amountUsd);

    return {
      ok: true,
      spent_today_before: before,
      spent_today_after: after,
      cap_usd: cap,
    } as const;
  })();
}

/**
 * Record an *additional* spend after the LLM responds with its actual cost.
 *
 * This is the "true-up": tryReserve() reserved the upper-bound estimate;
 * recordSpend() reconciles to the observed value.  `delta` may be positive
 * (model used more tokens than estimated) or negative (used fewer).  Negative
 * deltas are clamped to never reduce below the day's running total.
 */
export function recordSpend(
  db: Database,
  delta: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  ensureMetricsTable(db);
  const metric = metricNameFor(dayKey(nowSeconds));
  return db.transaction(() => {
    const before =
      (
        db
          .prepare('SELECT value FROM memory_metrics WHERE metric = ?')
          .get(metric) as { value: number } | undefined
      )?.value ?? 0;

    const next = Math.max(0, before + delta);
    db.prepare(
      `INSERT INTO memory_metrics (id, metric, value, updated_at)
       VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(metric) DO UPDATE SET
         value = excluded.value,
         updated_at = strftime('%s','now')`,
    ).run(randomUUID(), metric, next);
    return next;
  })();
}
