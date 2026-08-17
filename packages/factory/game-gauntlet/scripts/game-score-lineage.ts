import { createHash } from "node:crypto";
import type { GameGauntletTerminalState } from "./game-gauntlet-contract";

export const GAME_SCORE_CONTRACT_VERSION = 1 as const;

export const SCORE_LENS_KINDS = ["hard", "composite"] as const;
export type ScoreLensKind = (typeof SCORE_LENS_KINDS)[number];

export const SCORE_CAPTURE_MODES = ["active-play", "static-frame", "recorded-session"] as const;
export type ScoreCaptureMode = (typeof SCORE_CAPTURE_MODES)[number];

export const SCORE_DELTA_BASES = ["same-lineage", "rescored-baseline"] as const;
export type ScoreDeltaBasis = (typeof SCORE_DELTA_BASES)[number];

export const CLOSURE_VERDICTS = ["hard-lanes-pass", "hard-lane-failure", "evidence-invalid"] as const;
export type ClosureVerdict = (typeof CLOSURE_VERDICTS)[number];

export const CLOSURE_DERIVATION = "hard-lane-status" as const;

export const GAME_SCORE_VIOLATION_CODES = [
  "unknown-version",
  "unknown-lens-kind",
  "unknown-capture-mode",
  "malformed-scope",
  "invalid-scale",
  "invalid-weights",
  "invalid-threshold",
  "invalid-capture-population",
  "value-out-of-scale",
  "candidate-identity-mismatch",
  "duplicate-lens-record",
  "missing-required-lens",
  "required-lens-not-hard",
  "lens-mismatch",
  "composite-to-visual-substitution",
  "unrelated-baseline-round",
  "rubric-version-mismatch",
  "critic-lineage-mismatch",
  "evidence-manifest-mismatch",
  "scale-mismatch",
  "weights-mismatch",
  "threshold-mismatch",
  "capture-population-mismatch",
  "missing-baseline-rescore",
  "rescore-scope-mismatch",
  "rescore-candidate-mismatch",
  "unknown-delta-lens",
  "duplicate-delta-lens",
  "scores-suppressed",
  "closure-narrative-override",
] as const;
export type GameScoreViolationCode = (typeof GAME_SCORE_VIOLATION_CODES)[number];

export interface GameScoreViolation {
  code: GameScoreViolationCode;
  subject: string;
  detail: string;
}

export class GameScoreContractViolation extends Error {
  readonly violations: readonly GameScoreViolation[];

  constructor(violations: readonly GameScoreViolation[]) {
    const summary = violations.map((violation) => `${violation.code}@${violation.subject}`).join(", ");
    super(`game score contract failed closed: ${summary}`);
    this.name = "GameScoreContractViolation";
    this.violations = violations;
  }
}

export interface ScoreScale {
  min: number;
  max: number;
}

export interface CriticLineage {
  criticId: string;
  criticVersion: string;
  promptDigest: string;
}

export interface CapturePopulation {
  populationId: string;
  sampleCount: number;
  captureMode: ScoreCaptureMode;
}

/** Every dimension a score must be namespaced by before any delta may be reported. */
export interface ScoreScope {
  contractVersion: typeof GAME_SCORE_CONTRACT_VERSION;
  lensId: string;
  lensKind: ScoreLensKind;
  rubricVersion: string;
  criticLineage: CriticLineage;
  evidenceManifestDigest: string;
  scale: ScoreScale;
  weights: Readonly<Record<string, number>>;
  threshold: number;
  capturePopulation: CapturePopulation;
}

export interface ScoreRecord {
  scope: ScoreScope;
  candidateId: string;
  candidateDigest: string;
  roundId: string;
  value: number;
  recordedAt: string;
}

export interface ScoreDeltaRequest {
  lensId: string;
  baseline: ScoreRecord;
  candidate: ScoreRecord;
  /** Rescore of the frozen baseline candidate under the candidate round's current lineage. */
  rescoredBaseline?: ScoreRecord | null;
}

export interface ScoreDeltaEvaluation {
  lensId: string;
  comparable: boolean;
  basis: ScoreDeltaBasis | null;
  baselineValue: number | null;
  candidateValue: number | null;
  delta: number | null;
  lineageChanges: readonly string[];
  violations: readonly GameScoreViolation[];
}

export interface HardLaneStatus {
  lensId: string;
  value: number;
  threshold: number;
  scale: ScoreScale;
  passed: boolean;
}

export interface CompositeLaneStatus {
  lensId: string;
  value: number;
  threshold: number;
  passed: boolean;
}

export interface ClosureStatement {
  verdict: ClosureVerdict;
  statement: string;
  derivedFrom: typeof CLOSURE_DERIVATION;
}

export interface ScoreReportInput {
  contractVersion: unknown;
  candidateId: string;
  candidateDigest: string;
  frozenBaselineCandidateDigest: string;
  evidenceValid: boolean;
  requiredHardLenses: readonly string[];
  scores: readonly ScoreRecord[];
  deltas: readonly ScoreDeltaRequest[];
  proposedClosure?: string | null;
}

export interface ScoreReport {
  contractVersion: typeof GAME_SCORE_CONTRACT_VERSION;
  valid: boolean;
  violations: readonly GameScoreViolation[];
  deltas: readonly ScoreDeltaEvaluation[];
  reportableDeltas: readonly ScoreDeltaEvaluation[];
  rejectedDeltas: readonly ScoreDeltaEvaluation[];
  hardLanes: readonly HardLaneStatus[];
  compositeLanes: readonly CompositeLaneStatus[];
  closure: ClosureStatement;
  scoresSuppressed: boolean;
  promotionBlocked: boolean;
  terminalState: GameGauntletTerminalState | null;
}

const LENS_KIND_SET: ReadonlySet<string> = new Set(SCORE_LENS_KINDS);
const CAPTURE_MODE_SET: ReadonlySet<string> = new Set(SCORE_CAPTURE_MODES);

/** Scope facets that a frozen-baseline rescore is allowed to reconcile. */
const RESCORABLE_FACETS = [
  "rubricVersion",
  "criticLineage",
  "evidenceManifestDigest",
  "scale",
  "weights",
  "threshold",
  "capturePopulation",
] as const;
type RescorableFacet = (typeof RESCORABLE_FACETS)[number];

const FACET_VIOLATION: Record<RescorableFacet, GameScoreViolationCode> = {
  rubricVersion: "rubric-version-mismatch",
  criticLineage: "critic-lineage-mismatch",
  evidenceManifestDigest: "evidence-manifest-mismatch",
  scale: "scale-mismatch",
  weights: "weights-mismatch",
  threshold: "threshold-mismatch",
  capturePopulation: "capture-population-mismatch",
};

export function assertGameScoreContractVersion(version: unknown): asserts version is 1 {
  if (version !== GAME_SCORE_CONTRACT_VERSION) {
    throw new GameScoreContractViolation([
      { code: "unknown-version", subject: "contractVersion", detail: `expected 1, received ${String(version)}` },
    ]);
  }
}

function canonicalWeights(weights: Readonly<Record<string, number>>): string {
  return Object.keys(weights)
    .sort()
    .map((key) => `${key}=${weights[key]}`)
    .join(",");
}

export function computeScoreScopeDigest(scope: ScoreScope): string {
  const hash = createHash("sha256");
  hash.update(
    [
      `v${GAME_SCORE_CONTRACT_VERSION}`,
      scope.lensId,
      scope.lensKind,
      scope.rubricVersion,
      `${scope.criticLineage.criticId}:${scope.criticLineage.criticVersion}:${scope.criticLineage.promptDigest}`,
      scope.evidenceManifestDigest,
      `${scope.scale.min}..${scope.scale.max}`,
      canonicalWeights(scope.weights),
      String(scope.threshold),
      `${scope.capturePopulation.populationId}:${scope.capturePopulation.sampleCount}:${scope.capturePopulation.captureMode}`,
    ].join("\0"),
  );
  return hash.digest("hex");
}

export function scoresComparable(left: ScoreScope, right: ScoreScope): boolean {
  return computeScoreScopeDigest(left) === computeScoreScopeDigest(right);
}

function facetDigest(scope: ScoreScope, facet: RescorableFacet): string {
  switch (facet) {
    case "criticLineage":
      return `${scope.criticLineage.criticId}:${scope.criticLineage.criticVersion}:${scope.criticLineage.promptDigest}`;
    case "scale":
      return `${scope.scale.min}..${scope.scale.max}`;
    case "weights":
      return canonicalWeights(scope.weights);
    case "capturePopulation":
      return `${scope.capturePopulation.populationId}:${scope.capturePopulation.sampleCount}:${scope.capturePopulation.captureMode}`;
    case "threshold":
      return String(scope.threshold);
    default:
      return String(scope[facet]);
  }
}

function lineageChanges(baseline: ScoreScope, candidate: ScoreScope): RescorableFacet[] {
  return RESCORABLE_FACETS.filter((facet) => facetDigest(baseline, facet) !== facetDigest(candidate, facet));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateScoreScope(scope: ScoreScope, subject: string): GameScoreViolation[] {
  const violations: GameScoreViolation[] = [];
  if (scope === null || typeof scope !== "object") {
    return [{ code: "malformed-scope", subject, detail: "scope must be an object" }];
  }
  if (scope.contractVersion !== GAME_SCORE_CONTRACT_VERSION) {
    violations.push({
      code: "unknown-version",
      subject,
      detail: `expected 1, received ${String(scope.contractVersion)}`,
    });
  }
  if (typeof scope.lensId !== "string" || !scope.lensId.trim()) {
    violations.push({ code: "malformed-scope", subject, detail: "lensId is required" });
  }
  if (!LENS_KIND_SET.has(scope.lensKind)) {
    violations.push({ code: "unknown-lens-kind", subject, detail: `lensKind=${String(scope.lensKind)}` });
  }
  if (typeof scope.rubricVersion !== "string" || !scope.rubricVersion.trim()) {
    violations.push({ code: "malformed-scope", subject, detail: "rubricVersion is required" });
  }
  const lineage = scope.criticLineage;
  if (
    lineage === null ||
    typeof lineage !== "object" ||
    !lineage.criticId?.trim() ||
    !lineage.criticVersion?.trim() ||
    !lineage.promptDigest?.trim()
  ) {
    violations.push({
      code: "malformed-scope",
      subject,
      detail: "criticLineage requires criticId, criticVersion, and promptDigest",
    });
  }
  if (typeof scope.evidenceManifestDigest !== "string" || !scope.evidenceManifestDigest.trim()) {
    violations.push({ code: "malformed-scope", subject, detail: "evidenceManifestDigest is required" });
  }
  const scale = scope.scale;
  if (scale === null || typeof scale !== "object" || !isFiniteNumber(scale.min) || !isFiniteNumber(scale.max) || scale.max <= scale.min) {
    violations.push({ code: "invalid-scale", subject, detail: "scale requires finite min < max" });
  }
  const weights = scope.weights;
  if (weights === null || typeof weights !== "object" || Array.isArray(weights) || Object.keys(weights).length === 0) {
    violations.push({ code: "invalid-weights", subject, detail: "weights must be a non-empty mapping" });
  } else if (Object.values(weights).some((weight) => !isFiniteNumber(weight) || weight < 0)) {
    violations.push({ code: "invalid-weights", subject, detail: "every weight must be a finite non-negative number" });
  }
  if (!isFiniteNumber(scope.threshold)) {
    violations.push({ code: "invalid-threshold", subject, detail: "threshold must be a finite number" });
  } else if (scale && isFiniteNumber(scale.min) && isFiniteNumber(scale.max) && (scope.threshold < scale.min || scope.threshold > scale.max)) {
    violations.push({ code: "invalid-threshold", subject, detail: "threshold must fall inside the declared scale" });
  }
  const population = scope.capturePopulation;
  if (
    population === null ||
    typeof population !== "object" ||
    !population.populationId?.trim() ||
    !Number.isInteger(population.sampleCount) ||
    population.sampleCount <= 0
  ) {
    violations.push({
      code: "invalid-capture-population",
      subject,
      detail: "capturePopulation requires populationId and a positive integer sampleCount",
    });
  } else if (!CAPTURE_MODE_SET.has(population.captureMode)) {
    violations.push({ code: "unknown-capture-mode", subject, detail: `captureMode=${String(population.captureMode)}` });
  }
  return violations;
}

function validateScoreRecord(record: ScoreRecord, subject: string): GameScoreViolation[] {
  if (record === null || typeof record !== "object") {
    return [{ code: "malformed-scope", subject, detail: "score record must be an object" }];
  }
  const violations = validateScoreScope(record.scope, subject);
  if (!isFiniteNumber(record.value)) {
    violations.push({ code: "value-out-of-scale", subject, detail: "value must be a finite number" });
  } else if (violations.every((violation) => violation.code !== "invalid-scale")) {
    const { min, max } = record.scope.scale;
    if (record.value < min || record.value > max) {
      violations.push({
        code: "value-out-of-scale",
        subject,
        detail: `${record.value} is outside ${min}..${max}`,
      });
    }
  }
  if (typeof record.candidateDigest !== "string" || !record.candidateDigest.trim()) {
    violations.push({ code: "candidate-identity-mismatch", subject, detail: "candidateDigest is required" });
  }
  if (typeof record.roundId !== "string" || !record.roundId.trim()) {
    violations.push({ code: "malformed-scope", subject, detail: "roundId is required" });
  }
  return violations;
}

export interface ScoreDeltaContext {
  frozenBaselineCandidateDigest: string;
  candidateDigest: string;
  scoresSuppressed: boolean;
}

export function evaluateScoreDelta(request: ScoreDeltaRequest, context: ScoreDeltaContext): ScoreDeltaEvaluation {
  const subject = request.lensId;
  const violations: GameScoreViolation[] = [
    ...validateScoreRecord(request.baseline, `${subject}:baseline`),
    ...validateScoreRecord(request.candidate, `${subject}:candidate`),
  ];

  const rejected = (extra: readonly GameScoreViolation[], changes: readonly string[] = []): ScoreDeltaEvaluation => ({
    lensId: subject,
    comparable: false,
    basis: null,
    baselineValue: null,
    candidateValue: null,
    delta: null,
    lineageChanges: changes,
    violations: [...violations, ...extra],
  });

  if (violations.length > 0) return rejected([]);

  const baselineScope = request.baseline.scope;
  const candidateScope = request.candidate.scope;

  if (baselineScope.lensId !== candidateScope.lensId || candidateScope.lensId !== subject) {
    return rejected([
      {
        code: "lens-mismatch",
        subject,
        detail: `baseline=${baselineScope.lensId} candidate=${candidateScope.lensId}`,
      },
    ]);
  }
  if (baselineScope.lensKind !== candidateScope.lensKind) {
    return rejected([
      {
        code: "composite-to-visual-substitution",
        subject,
        detail: `baseline lens is ${baselineScope.lensKind} while candidate lens is ${candidateScope.lensKind}`,
      },
    ]);
  }
  if (request.candidate.candidateDigest !== context.candidateDigest) {
    return rejected([
      {
        code: "candidate-identity-mismatch",
        subject,
        detail: `candidate score is attributed to ${request.candidate.candidateDigest}, round candidate is ${context.candidateDigest}`,
      },
    ]);
  }
  if (request.baseline.candidateDigest !== context.frozenBaselineCandidateDigest) {
    return rejected([
      {
        code: "unrelated-baseline-round",
        subject,
        detail: `baseline round ${request.baseline.roundId} scored ${request.baseline.candidateDigest}, frozen baseline is ${context.frozenBaselineCandidateDigest}`,
      },
    ]);
  }
  if (context.scoresSuppressed) {
    return rejected([{ code: "scores-suppressed", subject, detail: "evidence is invalid, so no delta may be reported" }]);
  }

  const changes = lineageChanges(baselineScope, candidateScope);
  if (changes.length === 0) {
    return {
      lensId: subject,
      comparable: true,
      basis: "same-lineage",
      baselineValue: request.baseline.value,
      candidateValue: request.candidate.value,
      delta: request.candidate.value - request.baseline.value,
      lineageChanges: [],
      violations: [],
    };
  }

  const rescored = request.rescoredBaseline;
  if (!rescored) {
    return rejected(
      [
        ...changes.map((facet) => ({
          code: FACET_VIOLATION[facet],
          subject,
          detail: `${facet} changed between baseline and candidate`,
        })),
        {
          code: "missing-baseline-rescore",
          subject,
          detail: `lineage changed (${changes.join(", ")}); rescore the frozen baseline before reporting a delta`,
        },
      ],
      changes,
    );
  }

  const rescoreViolations = validateScoreRecord(rescored, `${subject}:rescored-baseline`);
  if (rescoreViolations.length > 0) return rejected(rescoreViolations, changes);

  if (!scoresComparable(rescored.scope, candidateScope)) {
    return rejected(
      [
        {
          code: "rescore-scope-mismatch",
          subject,
          detail: "the rescored baseline was not produced under the candidate round lineage",
        },
      ],
      changes,
    );
  }
  if (rescored.candidateDigest !== request.baseline.candidateDigest) {
    return rejected(
      [
        {
          code: "rescore-candidate-mismatch",
          subject,
          detail: `rescore scored ${rescored.candidateDigest}, frozen baseline is ${request.baseline.candidateDigest}`,
        },
      ],
      changes,
    );
  }

  return {
    lensId: subject,
    comparable: true,
    basis: "rescored-baseline",
    baselineValue: rescored.value,
    candidateValue: request.candidate.value,
    delta: request.candidate.value - rescored.value,
    lineageChanges: changes,
    violations: [],
  };
}

function formatLane(lensId: string, value: number, threshold: number, passed: boolean, kind: ScoreLensKind): string {
  const label = kind === "composite" ? "composite" : "independent";
  const verdict = passed ? "passed" : "not established";
  return `${label} ${lensId} ${verdict} (${value.toFixed(3)} vs ${threshold.toFixed(3)})`;
}

export function deriveClosureStatement(
  hardLanes: readonly HardLaneStatus[],
  compositeLanes: readonly CompositeLaneStatus[],
  evidenceValid: boolean,
): ClosureStatement {
  if (!evidenceValid) {
    return {
      verdict: "evidence-invalid",
      statement: "closure withheld: score evidence is invalid, so no lane status may be reported",
      derivedFrom: CLOSURE_DERIVATION,
    };
  }
  const clauses = [
    ...compositeLanes.map((lane) => formatLane(lane.lensId, lane.value, lane.threshold, lane.passed, "composite")),
    ...hardLanes.map((lane) => formatLane(lane.lensId, lane.value, lane.threshold, lane.passed, "hard")),
  ];
  const allHardPass = hardLanes.length > 0 && hardLanes.every((lane) => lane.passed);
  return {
    verdict: allHardPass ? "hard-lanes-pass" : "hard-lane-failure",
    statement: clauses.join("; "),
    derivedFrom: CLOSURE_DERIVATION,
  };
}

export function evaluateScoreReport(input: ScoreReportInput): ScoreReport {
  assertGameScoreContractVersion(input.contractVersion);

  const violations: GameScoreViolation[] = [];
  const byLens = new Map<string, ScoreRecord>();

  for (const record of input.scores) {
    const subject = record?.scope?.lensId ?? "unknown-lens";
    const recordViolations = validateScoreRecord(record, subject);
    if (recordViolations.length > 0) {
      violations.push(...recordViolations);
      continue;
    }
    if (byLens.has(subject)) {
      violations.push({ code: "duplicate-lens-record", subject, detail: "one score per lens per round" });
      continue;
    }
    if (record.candidateDigest !== input.candidateDigest) {
      violations.push({
        code: "candidate-identity-mismatch",
        subject,
        detail: `score is attributed to ${record.candidateDigest}, round candidate is ${input.candidateDigest}`,
      });
      continue;
    }
    byLens.set(subject, record);
  }

  const hardLanes: HardLaneStatus[] = [];
  for (const lensId of input.requiredHardLenses) {
    const record = byLens.get(lensId);
    if (!record) {
      violations.push({ code: "missing-required-lens", subject: lensId, detail: "required hard lens has no score" });
      continue;
    }
    if (record.scope.lensKind !== "hard") {
      violations.push({
        code: "required-lens-not-hard",
        subject: lensId,
        detail: `a ${record.scope.lensKind} score cannot satisfy a hard lens requirement`,
      });
      continue;
    }
    hardLanes.push({
      lensId,
      value: record.value,
      threshold: record.scope.threshold,
      scale: record.scope.scale,
      passed: record.value >= record.scope.threshold,
    });
  }

  const compositeLanes: CompositeLaneStatus[] = [...byLens.values()]
    .filter((record) => record.scope.lensKind === "composite")
    .map((record) => ({
      lensId: record.scope.lensId,
      value: record.value,
      threshold: record.scope.threshold,
      passed: record.value >= record.scope.threshold,
    }));

  const scoresSuppressed = !input.evidenceValid || violations.length > 0;
  const context: ScoreDeltaContext = {
    frozenBaselineCandidateDigest: input.frozenBaselineCandidateDigest,
    candidateDigest: input.candidateDigest,
    scoresSuppressed,
  };

  const seenDeltaLenses = new Set<string>();
  const deltas: ScoreDeltaEvaluation[] = [];
  for (const request of input.deltas) {
    if (seenDeltaLenses.has(request.lensId)) {
      violations.push({ code: "duplicate-delta-lens", subject: request.lensId, detail: "one delta per lens per round" });
      continue;
    }
    seenDeltaLenses.add(request.lensId);
    if (!byLens.has(request.lensId)) {
      violations.push({
        code: "unknown-delta-lens",
        subject: request.lensId,
        detail: "a delta may only be reported for a lens scored in this round",
      });
      continue;
    }
    deltas.push(evaluateScoreDelta(request, context));
  }

  const reportableDeltas = deltas.filter((delta) => delta.comparable);
  const rejectedDeltas = deltas.filter((delta) => !delta.comparable);
  for (const delta of rejectedDeltas) violations.push(...delta.violations);

  const laneStatusUsable = input.evidenceValid && violations.length === 0;
  const closure = deriveClosureStatement(hardLanes, compositeLanes, laneStatusUsable);

  if (input.proposedClosure != null && input.proposedClosure !== closure.statement) {
    violations.push({
      code: "closure-narrative-override",
      subject: "closure",
      detail: "closure language must be generated from hard-lane status, not supplied by the reporter",
    });
  }

  const valid = input.evidenceValid && violations.length === 0;
  return {
    contractVersion: GAME_SCORE_CONTRACT_VERSION,
    valid,
    violations,
    deltas,
    reportableDeltas,
    rejectedDeltas,
    hardLanes,
    compositeLanes,
    closure,
    scoresSuppressed: !laneStatusUsable,
    promotionBlocked: !valid || hardLanes.some((lane) => !lane.passed),
    terminalState: valid ? null : ("INVALID_EVIDENCE" satisfies GameGauntletTerminalState),
  };
}

// ─── Axiom Veil regression fixtures ───────────────────────────────────────────

const VISUAL_LENS = "first-party-visual-parity";
const COMPOSITE_LENS = "vertical-slice-composite";

const ROUND_6_CANDIDATE = "sha256:axiom-veil-round-6";
const ROUND_7_CANDIDATE = "sha256:axiom-veil-round-7";

const VISUAL_SCALE: ScoreScale = { min: 0, max: 1 };

function visualScope(overrides: Partial<ScoreScope> = {}): ScoreScope {
  return {
    contractVersion: GAME_SCORE_CONTRACT_VERSION,
    lensId: VISUAL_LENS,
    lensKind: "hard",
    rubricVersion: "visual-parity-3",
    criticLineage: {
      criticId: "visual-critic",
      criticVersion: "3.1.0",
      promptDigest: "sha256:visual-critic-prompt-3-1-0",
    },
    evidenceManifestDigest: "sha256:round-7-evidence",
    scale: VISUAL_SCALE,
    weights: { lighting: 0.25, contact: 0.25, depth: 0.25, "signal-separation": 0.25 },
    threshold: 0.85,
    capturePopulation: { populationId: "active-play-24", sampleCount: 24, captureMode: "active-play" },
    ...overrides,
  };
}

function compositeScope(overrides: Partial<ScoreScope> = {}): ScoreScope {
  return {
    contractVersion: GAME_SCORE_CONTRACT_VERSION,
    lensId: COMPOSITE_LENS,
    lensKind: "composite",
    rubricVersion: "vertical-slice-2",
    criticLineage: {
      criticId: "composite-reporter",
      criticVersion: "2.0.0",
      promptDigest: "sha256:composite-reporter-2-0-0",
    },
    evidenceManifestDigest: "sha256:round-7-evidence",
    scale: VISUAL_SCALE,
    weights: { mechanical: 0.3, playthrough: 0.3, visual: 0.2, reliability: 0.2 },
    threshold: 0.85,
    capturePopulation: { populationId: "active-play-24", sampleCount: 24, captureMode: "active-play" },
    ...overrides,
  };
}

function record(scope: ScoreScope, candidateDigest: string, roundId: string, value: number): ScoreRecord {
  return {
    scope,
    candidateId: "axiom-veil-vertical-slice",
    candidateDigest,
    roundId,
    value,
    recordedAt: "2026-08-06T00:00:00Z",
  };
}

/** Round 6 rescored under the round-7 lineage: the only baseline that supports a visual delta. */
export const AXIOM_VEIL_ROUND_6_RESCORE: ScoreRecord = record(visualScope(), ROUND_6_CANDIDATE, "round-6-rescore", 0.661);

/** Round 6 as originally scored, under the superseded rubric and critic. */
export const AXIOM_VEIL_ROUND_6_ORIGINAL: ScoreRecord = record(
  visualScope({
    rubricVersion: "visual-parity-2",
    criticLineage: { criticId: "visual-critic", criticVersion: "2.4.0", promptDigest: "sha256:visual-critic-prompt-2-4-0" },
    evidenceManifestDigest: "sha256:round-6-evidence",
    capturePopulation: { populationId: "static-frame-8", sampleCount: 8, captureMode: "static-frame" },
  }),
  ROUND_6_CANDIDATE,
  "round-6",
  0.469,
);

export const AXIOM_VEIL_ROUND_7_VISUAL: ScoreRecord = record(visualScope(), ROUND_7_CANDIDATE, "round-7", 0.676);

export const AXIOM_VEIL_ROUND_7_COMPOSITE: ScoreRecord = record(compositeScope(), ROUND_7_CANDIDATE, "round-7", 0.86);

function reportInput(overrides: Partial<ScoreReportInput> = {}): ScoreReportInput {
  return {
    contractVersion: GAME_SCORE_CONTRACT_VERSION,
    candidateId: "axiom-veil-vertical-slice",
    candidateDigest: ROUND_7_CANDIDATE,
    frozenBaselineCandidateDigest: ROUND_6_CANDIDATE,
    evidenceValid: true,
    requiredHardLenses: [VISUAL_LENS],
    scores: [AXIOM_VEIL_ROUND_7_VISUAL, AXIOM_VEIL_ROUND_7_COMPOSITE],
    deltas: [
      {
        lensId: VISUAL_LENS,
        baseline: AXIOM_VEIL_ROUND_6_ORIGINAL,
        candidate: AXIOM_VEIL_ROUND_7_VISUAL,
        rescoredBaseline: AXIOM_VEIL_ROUND_6_RESCORE,
      },
    ],
    ...overrides,
  };
}

/** The legitimate round-6-rescore to round-7 comparison, with the visual hard lane still short. */
export const AXIOM_VEIL_COMPARABLE_ROUND: ScoreReportInput = reportInput();

/** The 0.860 composite reported as if it were the 0.676 visual score. */
export const AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE: ScoreReportInput = reportInput({
  deltas: [
    {
      lensId: VISUAL_LENS,
      baseline: record(compositeScope({ lensId: VISUAL_LENS }), ROUND_6_CANDIDATE, "round-6", 0.83),
      candidate: AXIOM_VEIL_ROUND_7_VISUAL,
      rescoredBaseline: null,
    },
  ],
});

/** Rubric, critic, evidence, and capture population all moved, and nobody rescored the baseline. */
export const AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE: ScoreReportInput = reportInput({
  deltas: [
    {
      lensId: VISUAL_LENS,
      baseline: AXIOM_VEIL_ROUND_6_ORIGINAL,
      candidate: AXIOM_VEIL_ROUND_7_VISUAL,
      rescoredBaseline: null,
    },
  ],
});

/** A flat-vector-era score from an unrelated candidate presented as the baseline. */
export const AXIOM_VEIL_UNRELATED_HISTORY_FIXTURE: ScoreReportInput = reportInput({
  deltas: [
    {
      lensId: VISUAL_LENS,
      baseline: record(visualScope(), "sha256:axiom-veil-round-3", "round-3", 0.436),
      candidate: AXIOM_VEIL_ROUND_7_VISUAL,
      rescoredBaseline: null,
    },
  ],
});

/** The composite passes its threshold while the visual hard lane does not. */
export const AXIOM_VEIL_BLENDED_CLOSURE_FIXTURE: ScoreReportInput = reportInput({
  proposedClosure: "first-party visual parity achieved; the project scored 0.860 against a 0.850 exit threshold",
});

/** Governed mutation upstream suppressed scoring for the round. */
export const AXIOM_VEIL_SUPPRESSED_EVIDENCE_FIXTURE: ScoreReportInput = reportInput({ evidenceValid: false });
