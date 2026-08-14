/**
 * capacity.ts — pending-queue ceiling check.
 *
 * Per seed AC: "Capacity ceiling: ≥5 pending candidates → hook returns
 * crystallization.backpressure metric, no new draft."
 *
 * The check counts crystallizations rows with approval_status='pending' AND
 * eval_status not yet final-rejected. On breach, the caller emits the metric
 * `crystallize.backpressure` and short-circuits without invoking the LLM.
 */

import type { Database } from 'bun:sqlite';
import { PENDING_CAPACITY_CEILING } from './types.js';

export interface CapacityResult {
  pending_count: number;
  ceiling: number;
  /** True if a NEW draft can proceed (pending < ceiling). */
  ok: boolean;
}

export function checkCapacity(
  db: Database,
  ceiling: number = PENDING_CAPACITY_CEILING,
): CapacityResult {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM crystallizations
        WHERE approval_status = 'pending'
          AND eval_status NOT IN ('mechanical_fail', 'replay_fail')`,
    )
    .get() as { c: number } | undefined;
  const pending_count = row?.c ?? 0;
  return { pending_count, ceiling, ok: pending_count < ceiling };
}
