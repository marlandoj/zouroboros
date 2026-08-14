/**
 * Cheap-probe regime gate for the evolve loop (roadmap #11, AIEWF §11 / Browserbase).
 *
 * The evolve executor selects execution mode purely on `prescription.program ?
 * autoloop(8h) : script` — nothing measures whether a CHEAP DETERMINISTIC command
 * already satisfies the metric target before committing the expensive agentic budget.
 * That is the $24-static-table anti-pattern: Browserbase burned four LLM iterations on
 * an HTML table BeautifulSoup solved sub-second, because no gate checked the regime.
 *
 * This module is the deterministic gate that closes that hole. `classifyRegime` is a
 * PURE function: given a playbook's optional operator-declared `cheapProbeCommand`, the
 * metric direction, the baseline and (optionally) the target, plus an INJECTED probe
 * runner, it runs the cheap command, measures the metric, and classifies the regime as:
 *
 *   - 'deterministic' — the cheap path already meets the target (or, absent a target,
 *     improves the baseline). Escalating to the 8h autoloop would be gold-plating.
 *   - 'agentic'       — the cheap path is insufficient. Escalation is justified.
 *   - 'unknown'       — no cheapProbeCommand, or the probe errored / returned an
 *     unparseable metric. FAIL-SAFE: the gate offers no opinion and the loop proceeds
 *     exactly as it does today. The gate can never BLOCK on uncertainty.
 *
 * No LLM, no network, no fs in the core — the probe runner is injected so the classifier
 * stays offline-testable and free of the very cost it exists to avoid. Advisory by
 * default at the call site; only an explicit enforce flag acts on 'deterministic'.
 */

export type Regime = 'deterministic' | 'agentic' | 'unknown';

export type MetricDirection = 'higher_is_better' | 'lower_is_better';

/** Result of running the cheap probe command (injected runner returns this). */
export interface ProbeResult {
  /** Parsed numeric metric value, or null when the command failed / was unparseable. */
  value: number | null;
  /** Whether the command exited successfully. */
  ok: boolean;
  /** Optional short detail for the rationale (stdout tail, error). */
  detail?: string;
}

/** Injected probe runner — runs a shell command and returns the measured metric. */
export type ProbeRunner = (cmd: string) => ProbeResult;

export interface RegimeInput {
  /** Operator-declared deterministic command that (cheaply) attempts the task. */
  cheapProbeCommand?: string | null;
  /** Metric direction — determines whether higher or lower cheapValue is better. */
  metricDirection: MetricDirection;
  /** Current baseline metric value (before any intervention). */
  baseline: number;
  /** Target metric value, when known. Absent ⇒ fall back to "improves baseline". */
  target?: number | null;
}

export interface RegimeClassification {
  regime: Regime;
  /** Measured value from the cheap probe, or null when not run / unparseable. */
  cheapValue: number | null;
  baseline: number;
  target?: number | null;
  /** Direction-aware: did the cheap value improve on the baseline? */
  improved: boolean;
  /** Direction-aware: did the cheap value meet/exceed the target (if a target exists)? */
  meetsTarget: boolean;
  /** Human- and model-readable explanation of the classification. */
  rationale: string;
}

/** Direction-aware "is a better than b" (strictly better). */
function isBetter(a: number, b: number, direction: MetricDirection): boolean {
  return direction === 'higher_is_better' ? a > b : a < b;
}

/** Direction-aware "does value meet-or-beat the target". */
function meetsOrBeats(value: number, target: number, direction: MetricDirection): boolean {
  return direction === 'higher_is_better' ? value >= target : value <= target;
}

/**
 * Classify the execution regime for a prescription using a cheap deterministic probe.
 * PURE — all IO happens inside the injected `probeRunner`.
 */
export function classifyRegime(input: RegimeInput, probeRunner: ProbeRunner): RegimeClassification {
  const { cheapProbeCommand, metricDirection, baseline, target } = input;

  // No operator-declared cheap probe ⇒ the gate has no opinion. Proceed as today.
  if (!cheapProbeCommand || cheapProbeCommand.trim() === '') {
    return {
      regime: 'unknown',
      cheapValue: null,
      baseline,
      target: target ?? null,
      improved: false,
      meetsTarget: false,
      rationale: 'No cheapProbeCommand declared — regime gate is a no-op (proceeding as today).',
    };
  }

  let probe: ProbeResult;
  try {
    probe = probeRunner(cheapProbeCommand);
  } catch (e: any) {
    // Runner threw — fail safe to 'unknown', never block escalation.
    return {
      regime: 'unknown',
      cheapValue: null,
      baseline,
      target: target ?? null,
      improved: false,
      meetsTarget: false,
      rationale: `Cheap probe runner threw (${String(e?.message ?? e).slice(0, 120)}) — fail-safe 'unknown'.`,
    };
  }

  // Command failed or metric unparseable ⇒ fail-safe 'unknown'.
  if (!probe.ok || probe.value === null || Number.isNaN(probe.value)) {
    return {
      regime: 'unknown',
      cheapValue: null,
      baseline,
      target: target ?? null,
      improved: false,
      meetsTarget: false,
      rationale: `Cheap probe ${probe.ok ? 'returned an unparseable metric' : 'failed'} — fail-safe 'unknown'` +
        (probe.detail ? ` (${probe.detail.slice(0, 120)})` : '') + '.',
    };
  }

  const cheapValue = probe.value;
  const improved = isBetter(cheapValue, baseline, metricDirection);
  const hasTarget = target !== undefined && target !== null && !Number.isNaN(target);
  const meetsTarget = hasTarget ? meetsOrBeats(cheapValue, target as number, metricDirection) : false;

  // 'deterministic' when the cheap path already meets the target, or (absent a target)
  // already improves the baseline — escalation would be gold-plating.
  const sufficient = hasTarget ? meetsTarget : improved;
  const regime: Regime = sufficient ? 'deterministic' : 'agentic';

  const dirWord = metricDirection === 'higher_is_better' ? 'higher-better' : 'lower-better';
  const rationale = sufficient
    ? `Cheap probe value ${cheapValue} ${hasTarget ? `meets target ${target}` : `improves baseline ${baseline}`} ` +
      `(${dirWord}) — deterministic path suffices; autoloop escalation would be gold-plating.`
    : `Cheap probe value ${cheapValue} ${hasTarget ? `misses target ${target}` : `does not improve baseline ${baseline}`} ` +
      `(${dirWord}) — deterministic path insufficient; agentic escalation justified.`;

  return {
    regime,
    cheapValue,
    baseline,
    target: hasTarget ? (target as number) : null,
    improved,
    meetsTarget,
    rationale,
  };
}

/**
 * Render a one-line advisory marker for the executor log. Kept trivial + pure so the
 * wiring site stays a single call.
 */
export function formatRegimeAdvisory(c: RegimeClassification): string {
  return `[REGIME] ${c.regime}: ${c.rationale}`;
}
