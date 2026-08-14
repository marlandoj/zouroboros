/**
 * llm-draft.ts — wires the SKILL.md drafting step to the shared model-client.
 *
 * Per memory `memory-model-migration` (PR #82): SKILL.md prose generation is a
 * `summarization` workload — gpt-4o-mini, ~$0.0002/run. Combined with the
 * cost-counter, every call is bounded by the per-run + daily caps from the
 * seed.
 *
 * The exported factory matches the `LlmDriver` shape `draft.ts` expects, so
 * the wiring is a pure adapter: the driver returns { content, cost_usd } and
 * the existing draft pipeline does the rest.
 */

import type { LlmDriver } from './draft.js';
import {
  DEFAULT_PER_RUN_CAP_USD,
  tryReserve,
  recordSpend,
} from './cost-counter.js';
import type { Database } from 'bun:sqlite';

// The real generator lives in zouroboros-memory's standalone module, which is
// outside selfheal's tsc rootDir. We resolve it lazily at call time so the
// type-checker doesn't trip on the cross-package source path. Tests inject a
// stub via opts.generator and never reach this path.
type GenerateFn = (opts: {
  prompt: string;
  system?: string;
  workload: 'gate' | 'extraction' | 'summarization' | 'briefing';
}) => Promise<{ content: string; cost_usd?: number }>;

async function loadDefaultGenerator(): Promise<GenerateFn> {
  // Use a runtime-computed specifier so tsc doesn't resolve it during build.
  const specifier = ['..', '..', '..', 'memory', 'src', 'standalone', 'model-client.js'].join('/');
  const mod: any = await import(specifier);
  return mod.generate as GenerateFn;
}

export interface RealLlmDriverOptions {
  /** memory_metrics db handle for cost reservation. */
  db: Database;
  /** Per-run cap (estimated upper bound charged before the call). */
  perRunReserveUsd?: number;
  /** Optional override for `system` prompt; defaults to the draft.ts SKILL_MD_SYSTEM. */
  system?: string;
  /** Test override for `generate()`; production uses the real model-client. */
  generator?: GenerateFn;
}

export class LlmCostCapExceededError extends Error {
  reason: 'cap_exceeded';
  spent_today_before: number;
  cap_usd: number;
  constructor(spent: number, cap: number) {
    super(`crystallize daily LLM cost cap exceeded ($${spent.toFixed(4)} / $${cap.toFixed(2)})`);
    this.name = 'LlmCostCapExceededError';
    this.reason = 'cap_exceeded';
    this.spent_today_before = spent;
    this.cap_usd = cap;
  }
}

/**
 * Build an LlmDriver bound to the shared model-client + memory_metrics db.
 *
 * Reservation flow:
 *   1. tryReserve(perRunReserveUsd) — atomically reserves the upper-bound
 *      against today's cap. If the cap is exceeded, throws BEFORE invoking
 *      the LLM (no token spend on a doomed call).
 *   2. generate({ workload: 'summarization', ... }) — runs the model.
 *   3. recordSpend(actual - reserved) — true-up to the observed cost.
 */
export function makeRealLlmDriver(opts: RealLlmDriverOptions): LlmDriver {
  const reserve = opts.perRunReserveUsd ?? DEFAULT_PER_RUN_CAP_USD;
  let cachedGenerator: GenerateFn | undefined = opts.generator;

  return async (prompt: string) => {
    const reservation = tryReserve(opts.db, reserve);
    if (!reservation.ok) {
      throw new LlmCostCapExceededError(
        reservation.spent_today_before,
        reservation.cap_usd,
      );
    }

    if (!cachedGenerator) cachedGenerator = await loadDefaultGenerator();
    const result = await cachedGenerator({
      prompt,
      system: opts.system,
      workload: 'summarization',
    });

    const delta = (result.cost_usd ?? 0) - reserve;
    recordSpend(opts.db, delta);

    return {
      content: result.content,
      cost_usd: result.cost_usd ?? 0,
    };
  };
}
