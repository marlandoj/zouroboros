/**
 * inflight-cap — the ONE named knob for conveyor concurrency (ZOU-925 / ZBT-D).
 *
 * FACTORY_INFLIGHT_CAP is the maximum number of concurrently active (status
 * "executing", completed_at=null) conveyor executions. It is defined in
 * config/runtime-flags.json, validated by runtime-config.ts (int 1-3), and
 * reaches processes through `runtime-config.ts export-env`. Rollback to 1 is
 * `runtime-config.ts set FACTORY_INFLIGHT_CAP 1` — a config change, no deploy.
 *
 * Four enforcement points read this knob and nothing else:
 *   1. [SYS] Factory Conveyor instruction — safety contract + step-0 preflight
 *      compare the active count against $FACTORY_INFLIGHT_CAP.
 *   2. Step-0 preflight skip — active >= cap ends the cycle (cap_reached).
 *   3. linear-puller.ts — pulls at most pullLimit() tickets per cycle.
 *   4. serial-intake-promoter.ts — global factory-ready queue occupancy is
 *      gated at the cap instead of a literal 1.
 *
 * The per-cycle dispatch batch deliberately stays at ONE ticket regardless of
 * the cap: concurrency accrues ACROSS cycles (a new ticket may be pulled while
 * a prior execution is still live), never by batching multiple tickets through
 * steps 2-5 in a single cycle. That keeps the single-ticket contract, dedup,
 * and worktree-isolation guarantees per cycle while allowing cap-many
 * overlapping executions.
 *
 * POOL_GLOBAL_CAP in pool-manager.ts is the SF-003 pool lane ceiling and is a
 * separate budget; the lanes are coupled only through externalInFlight().
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeExecutionLifecycle } from "./execution-lifecycle";
import { factoryStateRoot } from "./factory-state-root";

export const INFLIGHT_CAP_FLAG = "FACTORY_INFLIGHT_CAP";
export const INFLIGHT_CAP_MIN = 1;
export const INFLIGHT_CAP_MAX = 3;

/**
 * Read the cap from the environment (populated by runtime-config export-env).
 * Missing/empty falls back to 1 (serial — the historical behavior). An
 * explicitly set but invalid value throws: corrupted configuration must fail
 * closed, not silently serialize or silently widen.
 */
export function inflightCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env[INFLIGHT_CAP_FLAG];
  if (raw === undefined || raw === "") return INFLIGHT_CAP_MIN;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < INFLIGHT_CAP_MIN || n > INFLIGHT_CAP_MAX) {
    throw new Error(
      `${INFLIGHT_CAP_FLAG} invalid: "${raw}" (expected integer ${INFLIGHT_CAP_MIN}-${INFLIGHT_CAP_MAX})`,
    );
  }
  return n;
}

/**
 * Count live conveyor executions: exec-*.json in the factory state root whose
 * normalized lifecycle state is "executing". Parity with
 * pool-manager.externalInFlight() — held, pool-enqueued, delivery, and
 * terminal states do not own a slot. Torn/foreign files count nothing.
 */
export function activeExecutionCount(stateDir: string = factoryStateRoot()): number {
  if (!existsSync(stateDir)) return 0;
  let n = 0;
  for (const f of readdirSync(stateDir)) {
    if (!f.startsWith("exec-") || !f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(stateDir, f), "utf8")) as Record<string, unknown>;
      if (normalizeExecutionLifecycle(rec).state === "executing") n++;
    } catch {
      // torn/foreign file — never crash a preflight on bad state
    }
  }
  return n;
}

/**
 * Tickets the puller may return this cycle: headroom under the cap, clamped to
 * the per-cycle batch of 1 (see module doc). 0 when the cap is already filled.
 */
export function pullLimit(
  active: number = activeExecutionCount(),
  cap: number = inflightCap(),
): number {
  return Math.max(0, Math.min(1, cap - active));
}
