/**
 * Held-out post-flight verification — single-sourced (ZOU-882, ZNL-07 / B1).
 *
 * The rigorous evolution verification (regression detection, hidden held-out
 * divergence / Goodhart drift, and the success derivation that distrusts a
 * visible gain the hidden bank did not mirror) previously lived inline in ONE
 * entry point (standalone/evolve.ts). The library `evolve/executor.ts` used
 * weak placeholders instead. This module extracts that verification as pure,
 * injectable functions so BOTH surfaces can grade evolution with the SAME
 * logic (the eval-production parity AC). B1 makes standalone consume it
 * behavior-identically; B2 wires `executeEvolution` to it (the second consumer
 * at which parity is realized) and flips its success/eligibility semantics.
 *
 * Pure by construction: the only external effect — sampling the hidden held-out
 * bank for the post-flight score — is injected as a thunk, so the decision
 * logic is deterministic and unit-testable, and the thunk is invoked only when
 * the divergence guard would have called it inline (no extra sampling).
 */

import { buildDivergenceReport, type DivergenceReport } from '../introspect/holdout.js';

export interface ScorecardMetricLike {
  name: string;
  value: number;
  score: number;
  status: string;
}

export interface ScorecardLike {
  composite: number;
  metrics: ScorecardMetricLike[];
}

/** A metric whose score fell more than |threshold| between baseline and post. */
export interface RegressionDrop {
  name: string;
  delta: number;
}

export interface RegressionResult {
  regression: boolean;
  drops: RegressionDrop[];
}

/** The visible metric the hidden held-out bank mirrors. */
export const VISIBLE_HELDOUT_METRIC = 'Memory Recall';

/** A per-metric score drop beyond this counts as a regression. */
export const REGRESSION_THRESHOLD = -0.02;

/**
 * Pure regression check: any metric present in both scorecards whose score
 * dropped by more than |threshold| is a regression. Metrics with a negative
 * value on either side (unmeasurable) are skipped, matching the inline logic.
 */
export function detectRegression(
  baseline: ScorecardLike | null,
  post: ScorecardLike | null,
  threshold: number = REGRESSION_THRESHOLD,
): RegressionResult {
  const drops: RegressionDrop[] = [];
  if (baseline && post) {
    for (const postMetric of post.metrics) {
      const baseMetric = baseline.metrics.find((m) => m.name === postMetric.name);
      if (baseMetric && baseMetric.value >= 0 && postMetric.value >= 0) {
        const delta = postMetric.score - baseMetric.score;
        if (delta < threshold) {
          drops.push({ name: postMetric.name, delta });
        }
      }
    }
  }
  return { regression: drops.length > 0, drops };
}

export interface DivergenceInput {
  /** Hidden held-out composite before the change; null when unmeasurable. */
  hiddenBaseline: number | null;
  baseline: ScorecardLike | null;
  post: ScorecardLike | null;
  /** Samples the hidden held-out composite AFTER the change; null when unmeasurable. */
  scoreHiddenAfter: () => number | null;
  visibleMetric?: string;
}

/**
 * Pure held-out divergence: compares how the VISIBLE metric moved against how
 * the HIDDEN held-out bank moved. Returns null (tripwire off, never flags) when
 * the hidden bank is unmeasurable or the visible metric is absent from either
 * scorecard. `scoreHiddenAfter` is invoked only when the guard passes — exactly
 * where the inline code sampled it — so behavior and cost are identical.
 */
export function resolveDivergence(input: DivergenceInput): DivergenceReport | null {
  const { hiddenBaseline, baseline, post, scoreHiddenAfter } = input;
  const visibleMetric = input.visibleMetric ?? VISIBLE_HELDOUT_METRIC;
  if (hiddenBaseline === null || !baseline || !post) return null;
  const hiddenAfter = scoreHiddenAfter();
  const visBase = baseline.metrics.find((m) => m.name === visibleMetric);
  const visAfter = post.metrics.find((m) => m.name === visibleMetric);
  if (hiddenAfter === null || !visBase || !visAfter) return null;
  const visibleDelta = visAfter.score - visBase.score;
  const hiddenDelta = hiddenAfter - hiddenBaseline;
  return buildDivergenceReport(visibleDelta, hiddenDelta);
}

export interface VerifiedSuccessInput {
  execSuccess: boolean;
  regression: boolean;
  goodhartFlag: boolean;
}

/**
 * A change is verified-successful only when execution succeeded AND no metric
 * regressed AND the hidden held-out bank did not diverge from the visible gain.
 * Textual run markers alone (e.g. an autoloop "KEEP") can never satisfy this.
 */
export function deriveVerifiedSuccess(input: VerifiedSuccessInput): boolean {
  return input.execSuccess && !input.regression && !input.goodhartFlag;
}

export interface HeldoutVerification {
  regression: boolean;
  drops: RegressionDrop[];
  divergenceReport: DivergenceReport | null;
  goodhartFlag: boolean;
  verifiedSuccess: boolean;
}

export interface VerifyHeldoutInput {
  execSuccess: boolean;
  hiddenBaseline: number | null;
  baseline: ScorecardLike | null;
  post: ScorecardLike | null;
  scoreHiddenAfter: () => number | null;
  visibleMetric?: string;
  regressionThreshold?: number;
}

/**
 * Compose the full held-out verification into one verdict. This is the single
 * function both evolution surfaces call so their verification logic cannot drift
 * apart.
 */
export function verifyHeldout(input: VerifyHeldoutInput): HeldoutVerification {
  const { regression, drops } = detectRegression(
    input.baseline,
    input.post,
    input.regressionThreshold,
  );
  const divergenceReport = resolveDivergence({
    hiddenBaseline: input.hiddenBaseline,
    baseline: input.baseline,
    post: input.post,
    scoreHiddenAfter: input.scoreHiddenAfter,
    visibleMetric: input.visibleMetric,
  });
  const goodhartFlag = divergenceReport?.goodhartFlag ?? false;
  const verifiedSuccess = deriveVerifiedSuccess({
    execSuccess: input.execSuccess,
    regression,
    goodhartFlag,
  });
  return { regression, drops, divergenceReport, goodhartFlag, verifiedSuccess };
}

/** The success/reverted/detail override a held-out verdict imposes on a raw result. */
export interface HeldoutOverride {
  success: boolean;
  reverted: boolean;
  detail: string;
  verification: HeldoutVerification;
  /** True only when both baseline and post scorecards were captured. */
  measurable: boolean;
}

export interface HeldoutOverrideInput {
  /** The raw mode result's success (e.g. autoloop KEEP-text or script `result.ok`). */
  execSuccess: boolean;
  /** The raw mode result's reverted flag (never un-reverts). */
  reverted: boolean;
  /** The raw mode result's detail; the held-out verdict is prepended. */
  detail: string;
  hiddenBaseline: number | null;
  baseline: ScorecardLike | null;
  post: ScorecardLike | null;
  scoreHiddenAfter: () => number | null;
  visibleMetric?: string;
  regressionThreshold?: number;
}

/**
 * Apply the held-out verdict to a raw evolution result, FAIL-CLOSED.
 *
 * This is the B2 wiring point: the library promotion path (`executeEvolution`)
 * calls this to replace weak `success` semantics (KEEP-text authority / bare
 * `result.ok`) with the same measured held-out verification the standalone
 * strong path uses. Two rules distinguish it from the lenient inline standalone
 * grading, both mandated for a promotion-authority path:
 *
 *  1. **Fail-closed on unmeasurable evidence** — if either scorecard is null
 *     (introspect evaluator unavailable / threw), success is forced false. An
 *     evolution that could not be verified must never be certified or promoted.
 *  2. **Never un-reverts** — a raw result already marked reverted stays reverted.
 *
 * Pure: the only external effect (sampling the hidden bank) is the injected
 * `scoreHiddenAfter` thunk, invoked only when `verifyHeldout`'s guard passes.
 */
export function deriveHeldoutOverride(input: HeldoutOverrideInput): HeldoutOverride {
  const verification = verifyHeldout({
    execSuccess: input.execSuccess,
    hiddenBaseline: input.hiddenBaseline,
    baseline: input.baseline,
    post: input.post,
    scoreHiddenAfter: input.scoreHiddenAfter,
    visibleMetric: input.visibleMetric,
    regressionThreshold: input.regressionThreshold,
  });
  const measurable = input.baseline !== null && input.post !== null;
  const success = measurable && verification.verifiedSuccess;
  const reverted = input.reverted || !success;
  const line = measurable
    ? `[heldout] verified=${success} regression=${verification.regression} goodhart=${verification.goodhartFlag}`
    : `[heldout] unmeasurable — fail-closed (baseline=${input.baseline !== null} post=${input.post !== null})`;
  const detail = `${line}\n${input.detail}`.slice(0, 500);
  return { success, reverted, detail, verification, measurable };
}
