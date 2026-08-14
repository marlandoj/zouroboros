/**
 * Periodic distillation gate (ZOU-282, #5 of the Intelligence-Harness roadmap).
 *
 * Distillation turns the loop's *accumulation* (memory + procedure corpus) into *substrate*:
 * a LoRA / fine-tune that folds hard-won episodic and procedural knowledge into weights so it
 * is recalled implicitly instead of re-retrieved every turn. The training itself runs
 * out-of-process on a GPU (the tsc-excluded standalone runner emits a job manifest a trainer
 * consumes); THIS module is the intelligence around it — the gate that decides whether
 * distillation may run at all, and the examiner that decides whether the resulting artifact
 * may be accepted.
 *
 * The hard dependency (seed requirement): distillation MUST refuse to run unless the
 * anti-Goodhart drift audit on the corpus is clean. Crystallizing a drifting corpus into
 * weights is the worst failure mode in the whole system — it bakes proxy-gaming in
 * permanently, where the held-out tripwire (#1) and the intervention ledger (#3) can no
 * longer revert it. So the gate FAILS CLOSED: if cleanliness cannot be *proven* (the held-out
 * bank is unmeasurable, or a recent intervention tripped the Goodhart flag), it refuses.
 *
 * Two checkpoints, both reusing existing anti-Goodhart machinery rather than a new proxy:
 *   1. auditCorpusDrift  — pre-distillation gate. Clean requires (a) the held-out eval bank
 *      AGREES with the visible partition above a threshold (scoreEvalIntegrity, #1) AND (b)
 *      no intervention in the lookback window tripped the held-out Goodhart flag
 *      (interventionsWithDrift, #3). Unmeasurable integrity ⇒ not clean (fail-closed).
 *   2. evaluateDistillationArtifact — post-training acceptance gate. Accept the fine-tune
 *      only if it does NOT regress the HIDDEN held-out score (the same examiner evolve uses),
 *      so a model that fit the visible corpus while losing held-out competence is rejected.
 *
 * tsc note: type-checked (src/distill/). No bun:sqlite / Skills imports — the corpus counts
 * and the live held-out probe run in the standalone runner, which passes results in here.
 */

import type { EvalIntegrityReport } from '../introspect/holdout.js';
import type { InterventionDrift } from '../evolve/intervention-ledger.js';

/** Minimum held/visible agreement (scoreEvalIntegrity) for the corpus to count as clean. */
export const DEFAULT_MIN_EVAL_AGREEMENT = 0.9;
/** Lookback window (ms) over the intervention ledger for recent Goodhart drift. Default 30d. */
export const DEFAULT_DRIFT_LOOKBACK_MS = 30 * 24 * 3600 * 1000;
/** Max held-out-score regression tolerated when accepting a distilled artifact. */
export const DEFAULT_REGRESSION_TOLERANCE = 0.02;
/** A corpus below this many examples is too thin to be worth distilling. */
export const DEFAULT_MIN_CORPUS_EXAMPLES = 50;

export interface DistillConfig {
  minEvalAgreement: number;
  driftLookbackMs: number;
  regressionTolerance: number;
  minCorpusExamples: number;
}

export const DEFAULT_DISTILL_CONFIG: DistillConfig = {
  minEvalAgreement: DEFAULT_MIN_EVAL_AGREEMENT,
  driftLookbackMs: DEFAULT_DRIFT_LOOKBACK_MS,
  regressionTolerance: DEFAULT_REGRESSION_TOLERANCE,
  minCorpusExamples: DEFAULT_MIN_CORPUS_EXAMPLES,
};

/** A point-in-time snapshot of the distillable corpus (counts + content fingerprint). */
export interface CorpusSnapshot {
  /** Distinct training examples derived from facts + episodes + procedures. */
  exampleCount: number;
  facts: number;
  episodes: number;
  procedures: number;
  /** Deterministic fingerprint of the corpus contents — ties an audit/manifest to exact data. */
  contentHash: string;
  /** ISO timestamp the snapshot was taken. */
  takenAt: string;
}

/** A recent Goodhart-flagged intervention, reduced to what the gate reasons about. */
export interface RecentDriftFlag {
  prescriptionId: string;
  playbookId: string;
  createdAt: number; // epoch ms
  drift: InterventionDrift;
}

export interface DriftAuditInputs {
  /** Result of scoreEvalIntegrity() — null when the held-out bank is unmeasurable. */
  evalIntegrity: EvalIntegrityReport | null;
  /** Goodhart-flagged interventions (interventionsWithDrift), newest first. */
  driftFlags: RecentDriftFlag[];
  /** Now, for the lookback window. */
  now?: number;
}

export interface DriftAuditResult {
  clean: boolean;
  /** Human-readable reasons the corpus failed the audit (empty when clean). */
  reasons: string[];
  evalAgreement: number | null;
  recentDriftCount: number;
}

/**
 * Pre-distillation gate. The corpus is clean ONLY when its held-out eval bank agrees with the
 * visible partition above threshold AND no intervention in the lookback window tripped the
 * Goodhart flag. Fails closed on an unmeasurable bank — you may not distill a corpus you
 * cannot certify.
 */
export function auditCorpusDrift(
  inputs: DriftAuditInputs,
  config: DistillConfig = DEFAULT_DISTILL_CONFIG
): DriftAuditResult {
  const now = inputs.now ?? Date.now();
  const reasons: string[] = [];

  const evalAgreement = inputs.evalIntegrity ? inputs.evalIntegrity.agreement : null;
  if (evalAgreement === null) {
    reasons.push(
      'held-out eval bank is unmeasurable — cannot certify the corpus is drift-free (fail-closed)'
    );
  } else if (evalAgreement < config.minEvalAgreement) {
    reasons.push(
      `held-out/visible agreement ${evalAgreement.toFixed(3)} < ${config.minEvalAgreement} ` +
        '— the eval itself disagrees across the rotation, corpus is drifting'
    );
  }

  const recent = inputs.driftFlags.filter(
    (f) => f.drift.goodhartFlag && now - f.createdAt <= config.driftLookbackMs
  );
  if (recent.length > 0) {
    const ids = recent.slice(0, 3).map((f) => f.prescriptionId).join(', ');
    reasons.push(
      `${recent.length} intervention(s) tripped the held-out Goodhart flag within the lookback ` +
        `window (e.g. ${ids}) — proxy-gaming present, distilling would crystallize it`
    );
  }

  return {
    clean: reasons.length === 0,
    reasons,
    evalAgreement,
    recentDriftCount: recent.length,
  };
}

/** LoRA / fine-tune job spec the out-of-process trainer consumes. */
export interface DistillationManifest {
  version: number;
  createdAt: string;
  corpus: CorpusSnapshot;
  baseModel: string;
  method: 'lora' | 'qlora' | 'full';
  hyperparams: {
    rank: number;
    alpha: number;
    epochs: number;
    learningRate: number;
  };
  /** Acceptance gate the trainer must satisfy before the artifact is promoted. */
  acceptance: {
    examiner: 'held-out-hidden-bank';
    maxRegression: number;
  };
  /** The audit that authorized this run — provenance, so a manifest proves its gate passed. */
  audit: DriftAuditResult;
}

export interface DistillationDecision {
  proceed: boolean;
  /** Present only when proceed === true. */
  manifest: DistillationManifest | null;
  /** Present only when proceed === false. */
  refusal: string | null;
}

export interface GateDistillationOptions {
  baseModel?: string;
  method?: DistillationManifest['method'];
  hyperparams?: Partial<DistillationManifest['hyperparams']>;
  now?: number;
}

const DEFAULT_HYPERPARAMS: DistillationManifest['hyperparams'] = {
  rank: 16,
  alpha: 32,
  epochs: 3,
  learningRate: 1e-4,
};

/**
 * The full pre-flight: refuse unless the corpus is non-trivial AND the drift audit is clean;
 * otherwise emit a training manifest stamped with the authorizing audit. Never starts
 * training — that is the out-of-process trainer's job — it only decides and specifies.
 */
export function gateDistillation(
  snapshot: CorpusSnapshot,
  audit: DriftAuditResult,
  opts: GateDistillationOptions = {},
  config: DistillConfig = DEFAULT_DISTILL_CONFIG
): DistillationDecision {
  if (snapshot.exampleCount < config.minCorpusExamples) {
    return {
      proceed: false,
      manifest: null,
      refusal:
        `corpus too thin to distill: ${snapshot.exampleCount} examples < ${config.minCorpusExamples} ` +
        'minimum (accumulate more memory/procedures first)',
    };
  }

  if (!audit.clean) {
    return {
      proceed: false,
      manifest: null,
      refusal: `anti-Goodhart drift audit FAILED — distillation refused: ${audit.reasons.join('; ')}`,
    };
  }

  const manifest: DistillationManifest = {
    version: 1,
    createdAt: new Date(opts.now ?? Date.now()).toISOString(),
    corpus: snapshot,
    baseModel: opts.baseModel ?? 'base-model-unspecified',
    method: opts.method ?? 'lora',
    hyperparams: { ...DEFAULT_HYPERPARAMS, ...opts.hyperparams },
    acceptance: {
      examiner: 'held-out-hidden-bank',
      maxRegression: config.regressionTolerance,
    },
    audit,
  };

  return { proceed: true, manifest, refusal: null };
}

export interface AcceptanceVerdict {
  accept: boolean;
  /** preHiddenScore - postHiddenScore: positive = the fine-tune lost held-out competence. */
  regression: number;
  reason: string;
}

/**
 * Post-training acceptance gate. A distilled artifact is accepted only if it does not regress
 * the HIDDEN held-out score beyond tolerance — the same examiner evolve uses, so the loop
 * cannot promote a model that fit the visible corpus while quietly losing held-out skill.
 * Unmeasurable post-score (null) fails closed: an unverifiable artifact is never promoted.
 */
export function evaluateDistillationArtifact(
  preHiddenScore: number,
  postHiddenScore: number | null,
  config: DistillConfig = DEFAULT_DISTILL_CONFIG
): AcceptanceVerdict {
  if (postHiddenScore === null || !Number.isFinite(postHiddenScore)) {
    return {
      accept: false,
      regression: NaN,
      reason: 'post-distillation held-out score unmeasurable — artifact unverifiable, rejected (fail-closed)',
    };
  }
  const regression = preHiddenScore - postHiddenScore;
  if (regression > config.regressionTolerance + 1e-9) {
    return {
      accept: false,
      regression,
      reason:
        `held-out score regressed ${regression.toFixed(3)} (${preHiddenScore.toFixed(3)} → ` +
        `${postHiddenScore.toFixed(3)}) > tolerance ${config.regressionTolerance} — rejected`,
    };
  }
  return {
    accept: true,
    regression,
    reason:
      `held-out score held (${preHiddenScore.toFixed(3)} → ${postHiddenScore.toFixed(3)}, ` +
      `Δ ${(-regression).toFixed(3)}) within tolerance — accepted`,
  };
}

/**
 * FNV-1a-style 32-bit fingerprint over a list of corpus item keys. Deterministic and
 * order-independent (keys are sorted) so an identical corpus produces an identical hash,
 * tying an audit + manifest to exact data without embedding any content.
 */
export function corpusContentHash(itemKeys: string[]): string {
  const sorted = [...itemKeys].sort();
  let h = 0x811c9dc5;
  for (const key of sorted) {
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x0a; // record separator
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a corpus snapshot from raw counts + the item keys used for the fingerprint. Pure;
 * the standalone runner supplies counts/keys read from the live memory + procedure stores.
 */
export function buildCorpusSnapshot(input: {
  facts: number;
  episodes: number;
  procedures: number;
  itemKeys: string[];
  takenAt?: string;
}): CorpusSnapshot {
  const exampleCount = input.facts + input.episodes + input.procedures;
  return {
    exampleCount,
    facts: input.facts,
    episodes: input.episodes,
    procedures: input.procedures,
    contentHash: corpusContentHash(input.itemKeys),
    takenAt: input.takenAt ?? new Date().toISOString(),
  };
}

/** Pull the divergence flag onto a one-line summary for logs / escalation. */
export function summarizeDecision(decision: DistillationDecision): string {
  if (decision.proceed && decision.manifest) {
    const m = decision.manifest;
    return `PROCEED — ${m.corpus.exampleCount} examples, ${m.method} r${m.hyperparams.rank}, corpus ${m.corpus.contentHash}`;
  }
  return `REFUSE — ${decision.refusal ?? 'unknown reason'}`;
}
