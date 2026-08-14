/**
 * Shared introspect scorecard capture — single-sourced (ZOU-882, ZNL-07 / B2).
 *
 * The full-scorecard fetch used for held-out post-flight verification previously
 * lived only in standalone/evolve.ts (`getScorecard`). The library
 * `evolve/executor.ts` — which IS the crystallization/promotion path — had no
 * way to capture it, so it graded evolutions without the hidden held-out /
 * Goodhart check the standalone path applies. Extracting the capture here lets
 * BOTH surfaces snapshot the same introspect scorecard with one implementation
 * (the eval-production parity AC).
 *
 * The single external effect — running the introspect CLI — is injected as a
 * runner, so the parse/shape logic is deterministic and unit-testable and the
 * command string is identical to the inline version it replaces.
 */

import type { ScorecardLike } from './heldout-verification.js';

export interface ScorecardRunResult {
  stdout: string;
  ok: boolean;
  code: number;
}

/** Matches the `run` helper both evolve surfaces already define. */
export type ScorecardRunner = (cmd: string, timeout?: number) => ScorecardRunResult;

/**
 * Run the introspect CLI and parse the full scorecard. Returns null when the
 * CLI failed, produced no output, or emitted unparseable JSON — behavior and
 * command string are identical to the inline `getScorecard` this replaces, so
 * standalone stays byte-for-byte equivalent when it delegates here.
 */
export function getScorecard(
  introspectPath: string,
  run: ScorecardRunner,
): ScorecardLike | null {
  const result = run(`bun "${introspectPath}" --json 2>/dev/null`);
  if (!result.ok || !result.stdout) return null;
  try {
    const sc = JSON.parse(result.stdout);
    return {
      composite: sc.composite,
      metrics: sc.metrics.map((m: any) => ({
        name: m.name,
        value: m.value,
        score: m.score,
        status: m.status,
      })),
    };
  } catch {
    return null;
  }
}
