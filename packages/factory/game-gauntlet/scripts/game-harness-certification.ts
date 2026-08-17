import { createHash } from "node:crypto";
import type { GameGauntletTerminalState } from "./game-gauntlet-contract";
import {
  freezeManifest,
  manifestEntryFromContent,
  sha256Hex,
  type FrozenManifest,
} from "./game-manifest-contract";

export const GAME_HARNESS_CONTRACT_VERSION = 1 as const;

export const HARNESS_CERTIFICATION_CHECKS = [
  "frozen-build",
  "production-input-map",
  "title-dismissal",
  "clock-advance",
  "start-state",
  "action-transitions",
  "scenario-reachability",
  "runtime-identity",
] as const;
export type HarnessCertificationCheck = (typeof HARNESS_CERTIFICATION_CHECKS)[number];

export const HARNESS_CERTIFIED_VERDICT = "CERTIFIED" as const;
export const HARNESS_NOT_CERTIFIED_VERDICT = "HARNESS_NOT_CERTIFIED" as const;
export type HarnessCertificationVerdict =
  | typeof HARNESS_CERTIFIED_VERDICT
  | typeof HARNESS_NOT_CERTIFIED_VERDICT;

export const BINDING_SOURCES = ["production-input-map", "critic-brief", "manual"] as const;
export type BindingSource = (typeof BINDING_SOURCES)[number];

export const CERTIFIED_BINDING_SOURCE = "production-input-map" as const satisfies BindingSource;

export const HARNESS_VIOLATION_CODES = [
  "unknown-version",
  "candidate-identity-mismatch",
  "build-not-frozen",
  "build-identity-mismatch",
  "control-map-not-governed",
  "control-map-digest-mismatch",
  "malformed-input-map",
  "duplicate-action",
  "binding-not-derived",
  "binding-source-digest-mismatch",
  "unknown-action",
  "stale-binding",
  "duplicate-binding",
  "missing-required-action",
  "title-not-dismissed",
  "title-action-unavailable",
  "title-action-unbound",
  "clock-not-advanced",
  "frame-not-advanced",
  "start-state-not-reached",
  "not-grounded",
  "missing-transition",
  "unexpected-transition",
  "missing-scenario-probe",
  "scenario-unreachable",
  "missing-runtime-identity",
  "invalid-viewport",
  "invalid-device-pixel-ratio",
] as const;
export type HarnessViolationCode = (typeof HARNESS_VIOLATION_CODES)[number];

export interface HarnessViolation {
  code: HarnessViolationCode;
  check: HarnessCertificationCheck;
  subject: string;
  detail: string;
}

export class GameHarnessCertificationViolation extends Error {
  readonly violations: readonly HarnessViolation[];

  constructor(violations: readonly HarnessViolation[]) {
    const summary = violations.map((violation) => `${violation.code}@${violation.subject}`).join(", ");
    super(`${HARNESS_NOT_CERTIFIED_VERDICT}: ${summary}`);
    this.name = "GameHarnessCertificationViolation";
    this.violations = violations;
  }
}

export interface ProductionInputMapEntry {
  action: string;
  binding: string;
  playerAvailable: boolean;
}

export interface ProductionInputMap {
  contractVersion: typeof GAME_HARNESS_CONTRACT_VERSION;
  sourcePath: string;
  sourceSha256: string;
  entries: readonly ProductionInputMapEntry[];
  digest: string;
}

export interface HarnessBinding {
  action: string;
  binding: string;
  source: BindingSource;
  sourceDigest: string;
  playerAvailable: boolean;
}

export interface RuntimeIdentity {
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  renderer: string;
  driver: string;
  buildId: string;
  buildDigest: string;
}

export interface FrozenBuild {
  buildId: string;
  buildDigest: string;
  frozen: boolean;
}

export interface ExpectedTransition {
  action: string;
  fromState: string;
  toState: string;
}

export interface ObservedTransition extends ExpectedTransition {
  frameAdvance: number;
}

export interface ScenarioProbe {
  scenarioId: string;
  reached: boolean;
  detail: string | null;
}

export interface HarnessObservation {
  titleState: string;
  titleDismissedBy: string | null;
  stateAfterTitle: string;
  observedStartState: string;
  grounded: boolean;
  frameIndexBefore: number;
  frameIndexAfter: number;
  simClockMsBefore: number;
  simClockMsAfter: number;
  transitions: readonly ObservedTransition[];
  scenarioProbes: readonly ScenarioProbe[];
}

export interface HarnessCertificationInput {
  contractVersion: unknown;
  candidateId: string;
  frozenBuild: FrozenBuild;
  productionControlsManifest: FrozenManifest;
  productionInputMap: ProductionInputMap;
  bindings: readonly HarnessBinding[];
  requiredActions: readonly string[];
  requiredStartState: string;
  expectedTransitions: readonly ExpectedTransition[];
  rubricScenarios: readonly string[];
  runtimeIdentity: RuntimeIdentity;
  observation: HarnessObservation;
}

export interface HarnessCertificationDecision {
  verdict: HarnessCertificationVerdict;
  certified: boolean;
  criticDispatchAllowed: boolean;
  scoresSuppressed: boolean;
  terminalState: GameGauntletTerminalState | null;
  checks: Readonly<Record<HarnessCertificationCheck, boolean>>;
  violations: readonly HarnessViolation[];
  blockedReasons: readonly string[];
  runtimeIdentity: RuntimeIdentity;
}

function sortedEntries(entries: readonly ProductionInputMapEntry[]): ProductionInputMapEntry[] {
  return [...entries].sort((left, right) => (left.action < right.action ? -1 : left.action > right.action ? 1 : 0));
}

export function computeInputMapDigest(
  sourcePath: string,
  sourceSha256: string,
  entries: readonly ProductionInputMapEntry[],
): string {
  const hash = createHash("sha256");
  hash.update(`v${GAME_HARNESS_CONTRACT_VERSION}\n${sourcePath}\n${sourceSha256}\n`);
  for (const entry of sortedEntries(entries)) {
    hash.update(`${entry.action}\0${entry.binding}\0${entry.playerAvailable ? "1" : "0"}\n`);
  }
  return hash.digest("hex");
}

/**
 * Read the production input map from the shipped control-map source so that
 * bindings are never transcribed from a critic brief.
 */
export function freezeProductionInputMap(
  sourcePath: string,
  sourceContent: string,
  entries: readonly ProductionInputMapEntry[],
): ProductionInputMap {
  const violations: HarnessViolation[] = [];
  if (!sourcePath.trim()) {
    violations.push({
      code: "malformed-input-map",
      check: "production-input-map",
      subject: "sourcePath",
      detail: "the production control map path is required",
    });
  }
  if (entries.length === 0) {
    violations.push({
      code: "malformed-input-map",
      check: "production-input-map",
      subject: sourcePath,
      detail: "the production input map may not be empty",
    });
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.action !== "string" || !entry.action.trim()) {
      violations.push({
        code: "malformed-input-map",
        check: "production-input-map",
        subject: sourcePath,
        detail: "entry.action must be a non-empty string",
      });
      continue;
    }
    if (typeof entry.binding !== "string" || !entry.binding.trim()) {
      violations.push({
        code: "malformed-input-map",
        check: "production-input-map",
        subject: entry.action,
        detail: "entry.binding must be a non-empty string",
      });
    }
    if (typeof entry.playerAvailable !== "boolean") {
      violations.push({
        code: "malformed-input-map",
        check: "production-input-map",
        subject: entry.action,
        detail: "entry.playerAvailable must be a boolean",
      });
    }
    if (seen.has(entry.action)) {
      violations.push({
        code: "duplicate-action",
        check: "production-input-map",
        subject: entry.action,
        detail: "an action may appear once in the production input map",
      });
    }
    seen.add(entry.action);
  }
  if (violations.length > 0) throw new GameHarnessCertificationViolation(violations);

  const sourceSha256 = sha256Hex(sourceContent);
  const ordered = sortedEntries(entries).map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({
    contractVersion: GAME_HARNESS_CONTRACT_VERSION,
    sourcePath,
    sourceSha256,
    entries: Object.freeze(ordered),
    digest: computeInputMapDigest(sourcePath, sourceSha256, ordered),
  }) satisfies ProductionInputMap;
}

export function deriveHarnessBindings(
  map: ProductionInputMap,
  requiredActions: readonly string[],
): readonly HarnessBinding[] {
  const byAction = new Map(map.entries.map((entry) => [entry.action, entry] as const));
  const violations: HarnessViolation[] = [];
  const bindings: HarnessBinding[] = [];

  for (const action of requiredActions) {
    const entry = byAction.get(action);
    if (!entry) {
      violations.push({
        code: "missing-required-action",
        check: "production-input-map",
        subject: action,
        detail: "the production input map does not bind this required action",
      });
      continue;
    }
    bindings.push({
      action: entry.action,
      binding: entry.binding,
      source: CERTIFIED_BINDING_SOURCE,
      sourceDigest: map.digest,
      playerAvailable: entry.playerAvailable,
    });
  }
  if (violations.length > 0) throw new GameHarnessCertificationViolation(violations);
  return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
}

function checkFrozenBuild(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const build = input.frozenBuild;
  if (!build?.frozen) {
    violations.push({
      code: "build-not-frozen",
      check: "frozen-build",
      subject: String(build?.buildId ?? "unknown"),
      detail: "the harness must load a frozen production build",
    });
  }
  if (!build?.buildId?.trim() || !build?.buildDigest?.trim()) {
    violations.push({
      code: "build-identity-mismatch",
      check: "frozen-build",
      subject: String(build?.buildId ?? "unknown"),
      detail: "buildId and buildDigest are required",
    });
    return;
  }
  const identity = input.runtimeIdentity;
  if (identity?.buildId !== build.buildId || identity?.buildDigest !== build.buildDigest) {
    violations.push({
      code: "build-identity-mismatch",
      check: "frozen-build",
      subject: build.buildId,
      detail: `recorded runtime build ${String(identity?.buildId)}@${String(identity?.buildDigest)} is not the frozen build`,
    });
  }
}

function checkProductionInputMap(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const map = input.productionInputMap;
  if (map?.contractVersion !== GAME_HARNESS_CONTRACT_VERSION) {
    violations.push({
      code: "unknown-version",
      check: "production-input-map",
      subject: String(map?.contractVersion),
      detail: `expected harness contract version ${GAME_HARNESS_CONTRACT_VERSION}`,
    });
    return;
  }

  const recomputed = computeInputMapDigest(map.sourcePath, map.sourceSha256, map.entries);
  if (map.digest !== recomputed) {
    violations.push({
      code: "binding-source-digest-mismatch",
      check: "production-input-map",
      subject: map.sourcePath,
      detail: `recorded ${String(map.digest)} does not match recomputed ${recomputed}`,
    });
  }

  const governed = input.productionControlsManifest?.entries?.find((entry) => entry.path === map.sourcePath);
  if (!governed) {
    violations.push({
      code: "control-map-not-governed",
      check: "production-input-map",
      subject: map.sourcePath,
      detail: "the control map source is absent from the frozen production-controls manifest",
    });
  } else if (governed.sha256 !== map.sourceSha256) {
    violations.push({
      code: "control-map-digest-mismatch",
      check: "production-input-map",
      subject: map.sourcePath,
      detail: `frozen ${governed.sha256} does not match harness-read ${map.sourceSha256}`,
    });
  }

  const byAction = new Map(map.entries.map((entry) => [entry.action, entry] as const));
  const bound = new Set<string>();
  for (const binding of input.bindings ?? []) {
    if (bound.has(binding.action)) {
      violations.push({
        code: "duplicate-binding",
        check: "production-input-map",
        subject: binding.action,
        detail: "an action may be bound once per certification",
      });
    }
    bound.add(binding.action);

    if (binding.source !== CERTIFIED_BINDING_SOURCE) {
      violations.push({
        code: "binding-not-derived",
        check: "production-input-map",
        subject: binding.action,
        detail: `binding was taken from ${String(binding.source)} instead of the production input map`,
      });
    }
    if (binding.sourceDigest !== map.digest) {
      violations.push({
        code: "binding-source-digest-mismatch",
        check: "production-input-map",
        subject: binding.action,
        detail: "binding was derived from a different input map revision",
      });
    }
    const entry = byAction.get(binding.action);
    if (!entry) {
      violations.push({
        code: "unknown-action",
        check: "production-input-map",
        subject: binding.action,
        detail: "the production input map does not contain this action",
      });
      continue;
    }
    if (entry.binding !== binding.binding) {
      violations.push({
        code: "stale-binding",
        check: "production-input-map",
        subject: binding.action,
        detail: `production binds ${entry.binding}, the harness used ${String(binding.binding)}`,
      });
    }
    if (entry.playerAvailable !== binding.playerAvailable) {
      violations.push({
        code: "stale-binding",
        check: "production-input-map",
        subject: binding.action,
        detail: "player availability does not match the production input map",
      });
    }
  }

  for (const action of input.requiredActions ?? []) {
    if (!bound.has(action)) {
      violations.push({
        code: "missing-required-action",
        check: "production-input-map",
        subject: action,
        detail: "a required action has no certified binding",
      });
    }
  }
}

function checkTitleDismissal(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const observation = input.observation;
  const dismissedBy = observation?.titleDismissedBy;
  if (!dismissedBy?.trim()) {
    violations.push({
      code: "title-not-dismissed",
      check: "title-dismissal",
      subject: String(observation?.titleState ?? "unknown"),
      detail: "the harness never dismissed the title through a player-available action",
    });
    return;
  }
  const binding = (input.bindings ?? []).find((candidate) => candidate.action === dismissedBy);
  if (!binding) {
    violations.push({
      code: "title-action-unbound",
      check: "title-dismissal",
      subject: dismissedBy,
      detail: "the dismissing action has no binding derived from the production input map",
    });
  } else if (!binding.playerAvailable) {
    violations.push({
      code: "title-action-unavailable",
      check: "title-dismissal",
      subject: dismissedBy,
      detail: "the dismissing action is not available to an ordinary player",
    });
  }
  if (observation.stateAfterTitle === observation.titleState) {
    violations.push({
      code: "title-not-dismissed",
      check: "title-dismissal",
      subject: observation.titleState,
      detail: "the observed state did not leave the title after the dismissing action",
    });
  }
}

function checkClockAdvance(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const observation = input.observation;
  const frames = [observation?.frameIndexBefore, observation?.frameIndexAfter];
  if (!frames.every((value) => Number.isInteger(value) && (value as number) >= 0)) {
    violations.push({
      code: "frame-not-advanced",
      check: "clock-advance",
      subject: `${String(observation?.frameIndexBefore)}->${String(observation?.frameIndexAfter)}`,
      detail: "frame indices must be non-negative integers",
    });
  } else if (observation.frameIndexAfter <= observation.frameIndexBefore) {
    violations.push({
      code: "frame-not-advanced",
      check: "clock-advance",
      subject: `${observation.frameIndexBefore}->${observation.frameIndexAfter}`,
      detail: "the harness measured a pinned frame",
    });
  }

  const clocks = [observation?.simClockMsBefore, observation?.simClockMsAfter];
  if (!clocks.every((value) => Number.isFinite(value) && (value as number) >= 0)) {
    violations.push({
      code: "clock-not-advanced",
      check: "clock-advance",
      subject: `${String(observation?.simClockMsBefore)}->${String(observation?.simClockMsAfter)}`,
      detail: "simulation clock readings must be non-negative numbers",
    });
  } else if (observation.simClockMsAfter <= observation.simClockMsBefore) {
    violations.push({
      code: "clock-not-advanced",
      check: "clock-advance",
      subject: `${observation.simClockMsBefore}->${observation.simClockMsAfter}`,
      detail: "the simulation clock did not advance",
    });
  }
}

function checkStartState(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const observation = input.observation;
  if (observation?.observedStartState !== input.requiredStartState) {
    violations.push({
      code: "start-state-not-reached",
      check: "start-state",
      subject: String(observation?.observedStartState),
      detail: `the rubric requires the ${input.requiredStartState} start state`,
    });
  }
  if (observation?.grounded !== true) {
    violations.push({
      code: "not-grounded",
      check: "start-state",
      subject: String(observation?.observedStartState),
      detail: "the harness never reached a grounded start state",
    });
  }
}

function checkActionTransitions(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const observed = new Map(
    (input.observation?.transitions ?? []).map((transition) => [transition.action, transition] as const),
  );
  for (const expected of input.expectedTransitions ?? []) {
    const transition = observed.get(expected.action);
    if (!transition) {
      violations.push({
        code: "missing-transition",
        check: "action-transitions",
        subject: expected.action,
        detail: "no observed state transition for a bound action",
      });
      continue;
    }
    if (transition.fromState !== expected.fromState || transition.toState !== expected.toState) {
      violations.push({
        code: "unexpected-transition",
        check: "action-transitions",
        subject: expected.action,
        detail:
          `expected ${expected.fromState}->${expected.toState}, ` +
          `observed ${String(transition.fromState)}->${String(transition.toState)}`,
      });
    }
    if (!Number.isInteger(transition.frameAdvance) || transition.frameAdvance <= 0) {
      violations.push({
        code: "frame-not-advanced",
        check: "action-transitions",
        subject: expected.action,
        detail: "an action transition must advance at least one frame",
      });
    }
  }
}

function checkScenarioReachability(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const probes = new Map(
    (input.observation?.scenarioProbes ?? []).map((probe) => [probe.scenarioId, probe] as const),
  );
  for (const scenarioId of input.rubricScenarios ?? []) {
    const probe = probes.get(scenarioId);
    if (!probe) {
      violations.push({
        code: "missing-scenario-probe",
        check: "scenario-reachability",
        subject: scenarioId,
        detail: "a rubric scenario has no reachability probe",
      });
      continue;
    }
    if (!probe.reached) {
      violations.push({
        code: "scenario-unreachable",
        check: "scenario-reachability",
        subject: scenarioId,
        detail: probe.detail ?? "the scenario was not reached with ordinary production controls",
      });
    }
  }
}

function checkRuntimeIdentity(input: HarnessCertificationInput, violations: HarnessViolation[]): void {
  const identity = input.runtimeIdentity;
  for (const field of ["renderer", "driver", "buildId", "buildDigest"] as const) {
    const value = identity?.[field];
    if (typeof value !== "string" || !value.trim()) {
      violations.push({
        code: "missing-runtime-identity",
        check: "runtime-identity",
        subject: field,
        detail: "runtime identity must record renderer, driver, and build identity",
      });
    }
  }
  for (const field of ["viewportWidth", "viewportHeight"] as const) {
    const value = identity?.[field];
    if (!Number.isInteger(value) || (value as number) <= 0) {
      violations.push({
        code: "invalid-viewport",
        check: "runtime-identity",
        subject: field,
        detail: "viewport dimensions must be positive integers",
      });
    }
  }
  if (!Number.isFinite(identity?.devicePixelRatio) || (identity?.devicePixelRatio ?? 0) <= 0) {
    violations.push({
      code: "invalid-device-pixel-ratio",
      check: "runtime-identity",
      subject: String(identity?.devicePixelRatio),
      detail: "device pixel ratio must be a positive number",
    });
  }
}

function formatBlockedReason(violation: HarnessViolation): string {
  return `${HARNESS_NOT_CERTIFIED_VERDICT}/${violation.check}/${violation.code}: ${violation.subject} - ${violation.detail}`;
}

export function certifyHarness(input: HarnessCertificationInput): HarnessCertificationDecision {
  const violations: HarnessViolation[] = [];

  if (input?.contractVersion !== GAME_HARNESS_CONTRACT_VERSION) {
    violations.push({
      code: "unknown-version",
      check: "frozen-build",
      subject: String(input?.contractVersion),
      detail: `expected harness contract version ${GAME_HARNESS_CONTRACT_VERSION}`,
    });
  }
  if (typeof input?.candidateId !== "string" || !input.candidateId.trim()) {
    violations.push({
      code: "candidate-identity-mismatch",
      check: "frozen-build",
      subject: String(input?.candidateId),
      detail: "candidateId is required",
    });
  }

  checkFrozenBuild(input, violations);
  checkProductionInputMap(input, violations);
  checkTitleDismissal(input, violations);
  checkClockAdvance(input, violations);
  checkStartState(input, violations);
  checkActionTransitions(input, violations);
  checkScenarioReachability(input, violations);
  checkRuntimeIdentity(input, violations);

  const failed = new Set(violations.map((violation) => violation.check));
  const checks = {} as Record<HarnessCertificationCheck, boolean>;
  for (const check of HARNESS_CERTIFICATION_CHECKS) checks[check] = !failed.has(check);

  const certified = violations.length === 0;
  return {
    verdict: certified ? HARNESS_CERTIFIED_VERDICT : HARNESS_NOT_CERTIFIED_VERDICT,
    certified,
    criticDispatchAllowed: certified,
    scoresSuppressed: !certified,
    terminalState: certified ? null : "BLOCKED",
    checks: Object.freeze(checks),
    violations,
    blockedReasons: violations.map(formatBlockedReason),
    runtimeIdentity: input.runtimeIdentity,
  };
}

export function assertHarnessCertified(input: HarnessCertificationInput): void {
  const decision = certifyHarness(input);
  if (!decision.certified) throw new GameHarnessCertificationViolation(decision.violations);
}

const AXIOM_VEIL_CANDIDATE_ID = "axiom-veil-slice-0004";
const AXIOM_VEIL_CONTROL_MAP_PATH = "src/input/controlMap.ts";
const AXIOM_VEIL_CONTROL_MAP_SOURCE = "export const counter = 'KeyJ';\n";

export const AXIOM_VEIL_PRODUCTION_INPUT_MAP: ProductionInputMap = freezeProductionInputMap(
  AXIOM_VEIL_CONTROL_MAP_PATH,
  AXIOM_VEIL_CONTROL_MAP_SOURCE,
  [
    { action: "confirm", binding: "Enter", playerAvailable: true },
    { action: "move-right", binding: "KeyD", playerAvailable: true },
    { action: "jump", binding: "Space", playerAvailable: true },
    { action: "counter", binding: "KeyJ", playerAvailable: true },
    { action: "debug-teleport", binding: "F9", playerAvailable: false },
  ],
);

export const AXIOM_VEIL_REQUIRED_ACTIONS = ["confirm", "move-right", "jump", "counter"] as const;

export const AXIOM_VEIL_HARNESS_BINDINGS: readonly HarnessBinding[] = deriveHarnessBindings(
  AXIOM_VEIL_PRODUCTION_INPUT_MAP,
  AXIOM_VEIL_REQUIRED_ACTIONS,
);

export const AXIOM_VEIL_PRODUCTION_CONTROLS_MANIFEST: FrozenManifest = freezeManifest("production-controls", [
  manifestEntryFromContent(AXIOM_VEIL_CONTROL_MAP_PATH, AXIOM_VEIL_CONTROL_MAP_SOURCE),
]);

export const AXIOM_VEIL_RUNTIME_IDENTITY: RuntimeIdentity = Object.freeze({
  viewportWidth: 1920,
  viewportHeight: 1080,
  devicePixelRatio: 2,
  renderer: "ANGLE (SwiftShader Device (Subzero))",
  driver: "SwiftShader 5.0.0",
  buildId: "axiom-veil-slice-0004-build",
  buildDigest: "sha256:frozen-production-build-0004",
});

export const AXIOM_VEIL_EXPECTED_TRANSITIONS: readonly ExpectedTransition[] = Object.freeze([
  { action: "confirm", fromState: "title", toState: "route-start" },
  { action: "move-right", fromState: "route-start", toState: "route-traversal" },
  { action: "jump", fromState: "route-traversal", toState: "route-airborne" },
  { action: "counter", fromState: "boss-approach", toState: "boss-counter" },
]);

export const AXIOM_VEIL_RUBRIC_SCENARIOS = ["route-to-boss", "counter-damage"] as const;

const CERTIFIED_OBSERVATION: HarnessObservation = Object.freeze({
  titleState: "title",
  titleDismissedBy: "confirm",
  stateAfterTitle: "route-start",
  observedStartState: "route-start",
  grounded: true,
  frameIndexBefore: 0,
  frameIndexAfter: 180,
  simClockMsBefore: 0,
  simClockMsAfter: 3000,
  transitions: Object.freeze([
    { action: "confirm", fromState: "title", toState: "route-start", frameAdvance: 6 },
    { action: "move-right", fromState: "route-start", toState: "route-traversal", frameAdvance: 12 },
    { action: "jump", fromState: "route-traversal", toState: "route-airborne", frameAdvance: 4 },
    { action: "counter", fromState: "boss-approach", toState: "boss-counter", frameAdvance: 8 },
  ]),
  scenarioProbes: Object.freeze([
    { scenarioId: "route-to-boss", reached: true, detail: null },
    { scenarioId: "counter-damage", reached: true, detail: null },
  ]),
});

function harnessInput(
  overrides: Partial<HarnessCertificationInput> = {},
  observationOverrides: Partial<HarnessObservation> = {},
): HarnessCertificationInput {
  return {
    contractVersion: GAME_HARNESS_CONTRACT_VERSION,
    candidateId: AXIOM_VEIL_CANDIDATE_ID,
    frozenBuild: {
      buildId: AXIOM_VEIL_RUNTIME_IDENTITY.buildId,
      buildDigest: AXIOM_VEIL_RUNTIME_IDENTITY.buildDigest,
      frozen: true,
    },
    productionControlsManifest: AXIOM_VEIL_PRODUCTION_CONTROLS_MANIFEST,
    productionInputMap: AXIOM_VEIL_PRODUCTION_INPUT_MAP,
    bindings: AXIOM_VEIL_HARNESS_BINDINGS,
    requiredActions: AXIOM_VEIL_REQUIRED_ACTIONS,
    requiredStartState: "route-start",
    expectedTransitions: AXIOM_VEIL_EXPECTED_TRANSITIONS,
    rubricScenarios: AXIOM_VEIL_RUBRIC_SCENARIOS,
    runtimeIdentity: AXIOM_VEIL_RUNTIME_IDENTITY,
    ...overrides,
    observation: { ...CERTIFIED_OBSERVATION, ...observationOverrides },
  };
}

export const AXIOM_VEIL_CERTIFIED_HARNESS: HarnessCertificationInput = harnessInput();

/** The title screen pinned at frame 0 that produced the original invalid criticism. */
export const AXIOM_VEIL_FROZEN_TITLE_FIXTURE: HarnessCertificationInput = harnessInput(
  {},
  {
    titleDismissedBy: null,
    stateAfterTitle: "title",
    observedStartState: "title",
    grounded: false,
    frameIndexAfter: 0,
    simClockMsAfter: 0,
    transitions: [],
    scenarioProbes: [
      { scenarioId: "route-to-boss", reached: false, detail: "title screen never dismissed" },
      { scenarioId: "counter-damage", reached: false, detail: "title screen never dismissed" },
    ],
  },
);

/** The simulation renders but never steps, so every measurement describes frame 0. */
export const AXIOM_VEIL_PINNED_CLOCK_FIXTURE: HarnessCertificationInput = harnessInput(
  {},
  { frameIndexAfter: 0, simClockMsAfter: 0 },
);

/** The critic brief named KeyK while production binds KeyJ. */
export const AXIOM_VEIL_STALE_CONTROLS_FIXTURE: HarnessCertificationInput = harnessInput({
  bindings: [
    ...AXIOM_VEIL_HARNESS_BINDINGS.filter((binding) => binding.action !== "counter"),
    {
      action: "counter",
      binding: "KeyK",
      source: "critic-brief",
      sourceDigest: "sha256:copied-critic-brief",
      playerAvailable: true,
    },
  ],
});

export const AXIOM_VEIL_UNREACHABLE_SCENARIO_FIXTURE: HarnessCertificationInput = harnessInput(
  {},
  {
    scenarioProbes: [
      { scenarioId: "route-to-boss", reached: true, detail: null },
      { scenarioId: "counter-damage", reached: false, detail: "arena gate never opened under ordinary controls" },
    ],
  },
);

export const AXIOM_VEIL_INVALID_START_STATE_FIXTURE: HarnessCertificationInput = harnessInput(
  {},
  { observedStartState: "route-airborne", grounded: false },
);

export const AXIOM_VEIL_UNRECORDED_RUNTIME_FIXTURE: HarnessCertificationInput = harnessInput({
  runtimeIdentity: {
    viewportWidth: 0,
    viewportHeight: 1080,
    devicePixelRatio: 0,
    renderer: "",
    driver: "",
    buildId: AXIOM_VEIL_RUNTIME_IDENTITY.buildId,
    buildDigest: AXIOM_VEIL_RUNTIME_IDENTITY.buildDigest,
  },
});

export const AXIOM_VEIL_MUTABLE_BUILD_FIXTURE: HarnessCertificationInput = harnessInput({
  frozenBuild: {
    buildId: AXIOM_VEIL_RUNTIME_IDENTITY.buildId,
    buildDigest: AXIOM_VEIL_RUNTIME_IDENTITY.buildDigest,
    frozen: false,
  },
});

export const AXIOM_VEIL_MUTATED_CONTROL_MAP_FIXTURE: HarnessCertificationInput = harnessInput({
  productionControlsManifest: freezeManifest("production-controls", [
    manifestEntryFromContent(AXIOM_VEIL_CONTROL_MAP_PATH, "export const counter = 'KeyK';\n"),
  ]),
});
