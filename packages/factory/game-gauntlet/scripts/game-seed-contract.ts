import type { GameGauntletTerminalState } from "./game-gauntlet-contract";

export const GAME_SEED_CONTRACT_VERSION = 1 as const;

export const GAME_SEED_DIMENSIONS = [
  "spatial",
  "temporal",
  "input",
  "health",
  "damage",
  "camera",
  "render",
  "collision",
  "checkpoint",
] as const;
export type GameSeedDimension = (typeof GAME_SEED_DIMENSIONS)[number];

export const CANONICAL_UNITS = {
  spatial: "world-unit",
  temporal: "second",
  input: "action-event",
  health: "hit-point",
  damage: "hit-point",
  camera: "world-unit",
  render: "device-pixel",
  collision: "world-unit",
  checkpoint: "world-unit",
} as const satisfies Record<GameSeedDimension, string>;

export const ALLOWED_UNITS = {
  spatial: ["world-unit", "metre", "centimetre"],
  temporal: ["second", "millisecond", "frame"],
  input: ["action-event", "input-frame"],
  health: ["hit-point", "health-fraction"],
  damage: ["hit-point", "health-fraction"],
  camera: ["world-unit", "metre"],
  render: ["device-pixel", "css-pixel"],
  collision: ["world-unit", "metre"],
  checkpoint: ["world-unit", "metre"],
} as const satisfies Record<GameSeedDimension, readonly string[]>;

export const REQUIRED_RATIO_PROBES = [
  "viewport-to-player-height",
  "room-width-to-run-speed",
  "jump-height-to-platform-rise",
  "projectile-reach-to-player-width",
  "health-to-damage-scale",
  "checkpoint-radius",
  "arena-bounds",
] as const;
export type RequiredRatioProbe = (typeof REQUIRED_RATIO_PROBES)[number];

export const TEACHING_STAGES = ["teach", "safe-practice", "test", "combine"] as const;
export type TeachingStage = (typeof TEACHING_STAGES)[number];

export const GAME_SEED_GATE_STAGES = ["parallel-implementation", "critic-dispatch"] as const;
export type GameSeedGateStage = (typeof GAME_SEED_GATE_STAGES)[number];

export const GAME_SEED_VIOLATION_CODES = [
  "unknown-version",
  "unknown-dimension",
  "missing-dimension",
  "unknown-unit",
  "invalid-scale",
  "inconsistent-unit-scale",
  "unit-scale-mismatch",
  "unknown-adapter",
  "missing-ratio-probe",
  "ratio-out-of-band",
  "missing-interaction-ownership",
  "duplicate-capability",
  "non-production-consumer",
  "incomplete-teaching-sequence",
  "untaught-mandatory-verb",
  "missing-recovery-entry",
  "missing-recovery-path",
  "unrecoverable-failure-mode",
  "recovery-budget-exceeded",
] as const;
export type GameSeedViolationCode = (typeof GAME_SEED_VIOLATION_CODES)[number];

export interface GameSeedViolation {
  code: GameSeedViolationCode;
  subject: string;
  detail: string;
}

export class GameSeedContractViolation extends Error {
  readonly violations: readonly GameSeedViolation[];

  constructor(violations: readonly GameSeedViolation[]) {
    const summary = violations.map((violation) => `${violation.code}@${violation.subject}`).join(", ");
    super(`game seed contract failed closed: ${summary}`);
    this.name = "GameSeedContractViolation";
    this.violations = violations;
  }
}

export interface UnitDeclaration {
  dimension: GameSeedDimension;
  unit: string;
  canonicalPerUnit: number;
}

export interface ModuleUnitDeclaration extends UnitDeclaration {
  module: string;
  adapter: string | null;
}

export interface RatioProbeDeclaration {
  probe: RequiredRatioProbe;
  measured: number;
  expectedMin: number;
  expectedMax: number;
}

export interface InteractionCapability {
  id: string;
  producer: string;
  consumer: string;
  consumerKind: "production" | "test-only";
  trigger: string;
  consequence: string;
  acceptanceProbe: string;
  failureModes: readonly string[];
}

export interface ProgressionTeachingEntry {
  verb: string;
  teachAt: number;
  safePracticeAt: number;
  testAt: number;
  combineAt: number;
  firstMandatoryUseAt: number;
}

export interface RecoveryMatrixEntry {
  failureMode: string;
  recoveryPath: string;
  resetPath: string;
  acceptanceProbe: string;
  maxLostProgressSeconds: number;
  softlockPossible: boolean;
}

export interface GameSeedDimensionalContract {
  contractVersion: unknown;
  unitBasis: readonly UnitDeclaration[];
  adapters: readonly string[];
  moduleUnits: readonly ModuleUnitDeclaration[];
  ratioProbes: readonly RatioProbeDeclaration[];
  interactions: readonly InteractionCapability[];
  mandatoryVerbs: readonly string[];
  progression: readonly ProgressionTeachingEntry[];
  recovery: readonly RecoveryMatrixEntry[];
  maxLostProgressSecondsBudget: number;
}

export interface UnitScaleMismatch {
  module: string;
  dimension: GameSeedDimension;
  moduleUnit: string;
  basisUnit: string;
  ratio: number;
}

export interface GameSeedContractReport {
  valid: boolean;
  violations: readonly GameSeedViolation[];
  blockedReasons: readonly string[];
  unitScaleMismatches: readonly UnitScaleMismatch[];
}

export interface GameSeedGateDecision {
  stage: GameSeedGateStage;
  allowed: boolean;
  terminalState: GameGauntletTerminalState | null;
  report: GameSeedContractReport;
}

const DIMENSION_SET: ReadonlySet<string> = new Set(GAME_SEED_DIMENSIONS);

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmpty(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isRouteOrdinal(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateUnitBasis(
  seed: GameSeedDimensionalContract,
  violations: GameSeedViolation[],
): Map<GameSeedDimension, UnitDeclaration> {
  const basis = new Map<GameSeedDimension, UnitDeclaration>();

  for (const declaration of seed.unitBasis) {
    if (!DIMENSION_SET.has(declaration.dimension)) {
      violations.push({
        code: "unknown-dimension",
        subject: String(declaration.dimension),
        detail: `basis declares a dimension outside the canonical nine`,
      });
      continue;
    }
    const allowed: readonly string[] = ALLOWED_UNITS[declaration.dimension];
    if (!allowed.includes(declaration.unit)) {
      violations.push({
        code: "unknown-unit",
        subject: `${declaration.dimension}:${declaration.unit}`,
        detail: `allowed units are ${allowed.join(", ")}`,
      });
      continue;
    }
    if (!isPositiveFinite(declaration.canonicalPerUnit)) {
      violations.push({
        code: "invalid-scale",
        subject: `${declaration.dimension}:${declaration.unit}`,
        detail: `canonicalPerUnit must be a positive finite number, received ${String(declaration.canonicalPerUnit)}`,
      });
      continue;
    }
    basis.set(declaration.dimension, declaration);
  }

  for (const dimension of GAME_SEED_DIMENSIONS) {
    if (!basis.has(dimension)) {
      violations.push({
        code: "missing-dimension",
        subject: dimension,
        detail: `seed must declare a canonical ${dimension} unit (canonical basis ${CANONICAL_UNITS[dimension]})`,
      });
    }
  }

  return basis;
}

function validateModuleUnits(
  seed: GameSeedDimensionalContract,
  basis: ReadonlyMap<GameSeedDimension, UnitDeclaration>,
  violations: GameSeedViolation[],
): UnitScaleMismatch[] {
  const mismatches: UnitScaleMismatch[] = [];
  const adapters = new Set(seed.adapters.filter(isNonEmpty));
  const observedScales = new Map<string, number>();

  for (const declaration of seed.moduleUnits) {
    const subject = `${declaration.module}:${declaration.dimension}`;

    if (!DIMENSION_SET.has(declaration.dimension)) {
      violations.push({
        code: "unknown-dimension",
        subject,
        detail: `module declares a dimension outside the canonical nine`,
      });
      continue;
    }
    const allowed: readonly string[] = ALLOWED_UNITS[declaration.dimension];
    if (!allowed.includes(declaration.unit)) {
      violations.push({
        code: "unknown-unit",
        subject: `${subject}:${declaration.unit}`,
        detail: `allowed units are ${allowed.join(", ")}`,
      });
      continue;
    }
    if (!isPositiveFinite(declaration.canonicalPerUnit)) {
      violations.push({
        code: "invalid-scale",
        subject,
        detail: `canonicalPerUnit must be a positive finite number, received ${String(declaration.canonicalPerUnit)}`,
      });
      continue;
    }

    const scaleKey = `${declaration.dimension}:${declaration.unit}`;
    const observed = observedScales.get(scaleKey);
    if (observed === undefined) {
      observedScales.set(scaleKey, declaration.canonicalPerUnit);
    } else if (observed !== declaration.canonicalPerUnit) {
      violations.push({
        code: "inconsistent-unit-scale",
        subject,
        detail: `${scaleKey} is declared as both ${observed} and ${declaration.canonicalPerUnit}`,
      });
    }

    const basisDeclaration = basis.get(declaration.dimension);
    if (basisDeclaration === undefined) continue;

    const ratio = declaration.canonicalPerUnit / basisDeclaration.canonicalPerUnit;
    const differsFromBasis = declaration.unit !== basisDeclaration.unit || ratio !== 1;
    if (!differsFromBasis) continue;

    mismatches.push({
      module: declaration.module,
      dimension: declaration.dimension,
      moduleUnit: declaration.unit,
      basisUnit: basisDeclaration.unit,
      ratio,
    });

    if (declaration.adapter === null) {
      violations.push({
        code: "unit-scale-mismatch",
        subject,
        detail: `${declaration.unit} differs from the ${basisDeclaration.unit} basis by ${ratio}x with no named adapter`,
      });
      continue;
    }
    if (!adapters.has(declaration.adapter)) {
      violations.push({
        code: "unknown-adapter",
        subject,
        detail: `adapter ${declaration.adapter} is not declared in the seed adapter list`,
      });
    }
  }

  return mismatches;
}

function validateRatioProbes(seed: GameSeedDimensionalContract, violations: GameSeedViolation[]): void {
  const declared = new Map<string, RatioProbeDeclaration>();
  for (const probe of seed.ratioProbes) declared.set(probe.probe, probe);

  for (const required of REQUIRED_RATIO_PROBES) {
    const probe = declared.get(required);
    if (probe === undefined) {
      violations.push({
        code: "missing-ratio-probe",
        subject: required,
        detail: `every seed must smoke ${required} before parallel builders start`,
      });
      continue;
    }
    if (
      !Number.isFinite(probe.measured) ||
      !Number.isFinite(probe.expectedMin) ||
      !Number.isFinite(probe.expectedMax) ||
      probe.expectedMin > probe.expectedMax
    ) {
      violations.push({
        code: "invalid-scale",
        subject: required,
        detail: `ratio probe bounds must be finite with expectedMin <= expectedMax`,
      });
      continue;
    }
    if (probe.measured < probe.expectedMin || probe.measured > probe.expectedMax) {
      violations.push({
        code: "ratio-out-of-band",
        subject: required,
        detail: `measured ${probe.measured} is outside [${probe.expectedMin}, ${probe.expectedMax}]`,
      });
    }
  }
}

function validateInteractions(seed: GameSeedDimensionalContract, violations: GameSeedViolation[]): void {
  const seen = new Set<string>();

  for (const capability of seed.interactions) {
    const subject = isNonEmpty(capability.id) ? capability.id : "<unnamed-capability>";

    if (!isNonEmpty(capability.id)) {
      violations.push({
        code: "missing-interaction-ownership",
        subject,
        detail: `capability id is required`,
      });
    } else if (seen.has(capability.id)) {
      violations.push({
        code: "duplicate-capability",
        subject,
        detail: `capability id is declared more than once`,
      });
    } else {
      seen.add(capability.id);
    }

    const required: ReadonlyArray<[string, string]> = [
      ["producer", capability.producer],
      ["consumer", capability.consumer],
      ["trigger", capability.trigger],
      ["consequence", capability.consequence],
      ["acceptanceProbe", capability.acceptanceProbe],
    ];
    for (const [field, value] of required) {
      if (!isNonEmpty(value)) {
        violations.push({
          code: "missing-interaction-ownership",
          subject: `${subject}.${field}`,
          detail: `every interactive capability must name its ${field}`,
        });
      }
    }

    if (capability.consumerKind !== "production") {
      violations.push({
        code: "non-production-consumer",
        subject,
        detail: `consumer ${capability.consumer} is ${capability.consumerKind}; a capability is not built until production invokes it`,
      });
    }
  }
}

function validateProgression(seed: GameSeedDimensionalContract, violations: GameSeedViolation[]): void {
  const taught = new Map<string, ProgressionTeachingEntry>();

  for (const entry of seed.progression) {
    const subject = isNonEmpty(entry.verb) ? entry.verb : "<unnamed-verb>";
    if (!isNonEmpty(entry.verb)) {
      violations.push({
        code: "incomplete-teaching-sequence",
        subject,
        detail: `teaching entry must name a verb`,
      });
      continue;
    }

    const ordinals: ReadonlyArray<[TeachingStage, number]> = [
      ["teach", entry.teachAt],
      ["safe-practice", entry.safePracticeAt],
      ["test", entry.testAt],
      ["combine", entry.combineAt],
    ];
    const malformed = ordinals.filter(([, ordinal]) => !isRouteOrdinal(ordinal));
    if (malformed.length > 0) {
      violations.push({
        code: "incomplete-teaching-sequence",
        subject,
        detail: `stages ${malformed.map(([stage]) => stage).join(", ")} must declare a non-negative integer route ordinal`,
      });
      continue;
    }
    if (!(entry.teachAt < entry.safePracticeAt && entry.safePracticeAt < entry.testAt && entry.testAt < entry.combineAt)) {
      violations.push({
        code: "incomplete-teaching-sequence",
        subject,
        detail: `route ordinals must strictly increase through teach -> safe practice -> test -> combine`,
      });
      continue;
    }

    taught.set(entry.verb, entry);

    if (!isRouteOrdinal(entry.firstMandatoryUseAt)) {
      violations.push({
        code: "untaught-mandatory-verb",
        subject,
        detail: `firstMandatoryUseAt must declare a non-negative integer route ordinal`,
      });
      continue;
    }
    if (entry.firstMandatoryUseAt < entry.testAt) {
      violations.push({
        code: "untaught-mandatory-verb",
        subject,
        detail: `mandatory use at ${entry.firstMandatoryUseAt} precedes the test stage at ${entry.testAt}`,
      });
    }
  }

  for (const verb of seed.mandatoryVerbs) {
    if (!taught.has(verb)) {
      violations.push({
        code: "untaught-mandatory-verb",
        subject: verb,
        detail: `mandatory verb has no complete teach -> safe practice -> test -> combine sequence`,
      });
    }
  }
}

function validateRecovery(seed: GameSeedDimensionalContract, violations: GameSeedViolation[]): void {
  const covered = new Set<string>();
  const budget = seed.maxLostProgressSecondsBudget;

  for (const entry of seed.recovery) {
    const subject = isNonEmpty(entry.failureMode) ? entry.failureMode : "<unnamed-failure-mode>";
    if (isNonEmpty(entry.failureMode)) covered.add(entry.failureMode);

    const required: ReadonlyArray<[string, string]> = [
      ["failureMode", entry.failureMode],
      ["recoveryPath", entry.recoveryPath],
      ["resetPath", entry.resetPath],
      ["acceptanceProbe", entry.acceptanceProbe],
    ];
    for (const [field, value] of required) {
      if (!isNonEmpty(value)) {
        violations.push({
          code: "missing-recovery-path",
          subject: `${subject}.${field}`,
          detail: `every failure mode must declare its ${field}`,
        });
      }
    }

    if (entry.softlockPossible) {
      violations.push({
        code: "unrecoverable-failure-mode",
        subject,
        detail: `failure mode admits a permanent stalemate; a recovery or reset path is mandatory`,
      });
    }

    if (!isPositiveFinite(entry.maxLostProgressSeconds)) {
      violations.push({
        code: "recovery-budget-exceeded",
        subject,
        detail: `maxLostProgressSeconds must be a positive finite number, received ${String(entry.maxLostProgressSeconds)}`,
      });
    } else if (!isPositiveFinite(budget) || entry.maxLostProgressSeconds > budget) {
      violations.push({
        code: "recovery-budget-exceeded",
        subject,
        detail: `maxLostProgressSeconds ${entry.maxLostProgressSeconds} exceeds the seed budget ${String(budget)}`,
      });
    }
  }

  for (const capability of seed.interactions) {
    const subject = isNonEmpty(capability.id) ? capability.id : "<unnamed-capability>";
    for (const failureMode of capability.failureModes) {
      if (!covered.has(failureMode)) {
        violations.push({
          code: "missing-recovery-entry",
          subject: `${subject}:${failureMode}`,
          detail: `failure mode has no recovery/reset matrix entry`,
        });
      }
    }
  }
}

export function collectUnitScaleMismatches(seed: GameSeedDimensionalContract): readonly UnitScaleMismatch[] {
  const violations: GameSeedViolation[] = [];
  const basis = validateUnitBasis(seed, violations);
  return validateModuleUnits(seed, basis, violations);
}

export function evaluateGameSeedContract(seed: GameSeedDimensionalContract): GameSeedContractReport {
  const violations: GameSeedViolation[] = [];

  if (seed.contractVersion !== GAME_SEED_CONTRACT_VERSION) {
    violations.push({
      code: "unknown-version",
      subject: String(seed.contractVersion),
      detail: `expected game seed contract version ${GAME_SEED_CONTRACT_VERSION}`,
    });
    return {
      valid: false,
      violations,
      blockedReasons: violations.map(formatBlockedReason),
      unitScaleMismatches: [],
    };
  }

  const basis = validateUnitBasis(seed, violations);
  const unitScaleMismatches = validateModuleUnits(seed, basis, violations);
  validateRatioProbes(seed, violations);
  validateInteractions(seed, violations);
  validateProgression(seed, violations);
  validateRecovery(seed, violations);

  return {
    valid: violations.length === 0,
    violations,
    blockedReasons: violations.map(formatBlockedReason),
    unitScaleMismatches,
  };
}

function formatBlockedReason(violation: GameSeedViolation): string {
  return `${violation.code}: ${violation.subject} - ${violation.detail}`;
}

export function assertGameSeedContract(seed: GameSeedDimensionalContract): void {
  const report = evaluateGameSeedContract(seed);
  if (!report.valid) {
    throw new GameSeedContractViolation(report.violations);
  }
}

export function gateGameSeedDispatch(
  seed: GameSeedDimensionalContract,
  stage: GameSeedGateStage,
): GameSeedGateDecision {
  const report = evaluateGameSeedContract(seed);
  return {
    stage,
    allowed: report.valid,
    terminalState: report.valid ? null : "BLOCKED",
    report,
  };
}

export function gateEveryGameSeedStage(
  seed: GameSeedDimensionalContract,
): readonly GameSeedGateDecision[] {
  return GAME_SEED_GATE_STAGES.map((stage) => gateGameSeedDispatch(seed, stage));
}

const AXIOM_VEIL_METRIC_MODULES = ["player", "camera", "combat", "enemies", "boss"] as const;

const AXIOM_VEIL_BASE_SEED: Omit<GameSeedDimensionalContract, "moduleUnits"> = {
  contractVersion: GAME_SEED_CONTRACT_VERSION,
  unitBasis: [
    { dimension: "spatial", unit: "world-unit", canonicalPerUnit: 1 },
    { dimension: "temporal", unit: "second", canonicalPerUnit: 1 },
    { dimension: "input", unit: "action-event", canonicalPerUnit: 1 },
    { dimension: "health", unit: "hit-point", canonicalPerUnit: 1 },
    { dimension: "damage", unit: "hit-point", canonicalPerUnit: 1 },
    { dimension: "camera", unit: "world-unit", canonicalPerUnit: 1 },
    { dimension: "render", unit: "device-pixel", canonicalPerUnit: 1 },
    { dimension: "collision", unit: "world-unit", canonicalPerUnit: 1 },
    { dimension: "checkpoint", unit: "world-unit", canonicalPerUnit: 1 },
  ],
  adapters: ["metresToWorldUnits"],
  ratioProbes: [
    { probe: "viewport-to-player-height", measured: 11.25, expectedMin: 8, expectedMax: 16 },
    { probe: "room-width-to-run-speed", measured: 6.4, expectedMin: 3, expectedMax: 12 },
    { probe: "jump-height-to-platform-rise", measured: 1.15, expectedMin: 1.05, expectedMax: 2 },
    { probe: "projectile-reach-to-player-width", measured: 9, expectedMin: 4, expectedMax: 20 },
    { probe: "health-to-damage-scale", measured: 8, expectedMin: 3, expectedMax: 20 },
    { probe: "checkpoint-radius", measured: 96, expectedMin: 40, expectedMax: 240 },
    { probe: "arena-bounds", measured: 1.4, expectedMin: 1.1, expectedMax: 3 },
  ],
  interactions: [
    {
      id: "hazard-spike-floor",
      producer: "rooms/hazards.ts",
      consumer: "game/collisionSystem.ts",
      consumerKind: "production",
      trigger: "player collider overlaps hazard volume",
      consequence: "player health decreases and knockback plays",
      acceptanceProbe: "probes/hazard-damage.spec.ts",
      failureModes: ["hazard-death"],
    },
    {
      id: "camera-arena-trigger",
      producer: "rooms/triggers.ts",
      consumer: "game/cameraDirector.ts",
      consumerKind: "production",
      trigger: "player crosses arena entry volume",
      consequence: "camera locks to arena bounds and gate closes",
      acceptanceProbe: "probes/arena-lock.spec.ts",
      failureModes: ["arena-escape"],
    },
    {
      id: "checkpoint-banner",
      producer: "rooms/checkpoints.ts",
      consumer: "game/checkpointSystem.ts",
      consumerKind: "production",
      trigger: "player enters checkpoint radius",
      consequence: "respawn anchor moves and banner renders",
      acceptanceProbe: "probes/checkpoint-anchor.spec.ts",
      failureModes: ["checkpoint-miss"],
    },
    {
      id: "boss-counter-window",
      producer: "boss/phases.ts",
      consumer: "game/combatResolver.ts",
      consumerKind: "production",
      trigger: "player parries during the telegraphed window",
      consequence: "boss health decreases and the phase advances",
      acceptanceProbe: "probes/counter-damage.spec.ts",
      failureModes: ["boss-phase-stall"],
    },
  ],
  mandatoryVerbs: ["run", "jump", "wall-jump", "counter"],
  progression: [
    { verb: "run", teachAt: 0, safePracticeAt: 1, testAt: 2, combineAt: 3, firstMandatoryUseAt: 2 },
    { verb: "jump", teachAt: 1, safePracticeAt: 2, testAt: 3, combineAt: 4, firstMandatoryUseAt: 3 },
    { verb: "wall-jump", teachAt: 4, safePracticeAt: 5, testAt: 6, combineAt: 7, firstMandatoryUseAt: 8 },
    { verb: "counter", teachAt: 6, safePracticeAt: 7, testAt: 8, combineAt: 9, firstMandatoryUseAt: 10 },
  ],
  recovery: [
    {
      failureMode: "hazard-death",
      recoveryPath: "invulnerability window plus knockback to the last safe ledge",
      resetPath: "respawn at the most recent checkpoint anchor",
      acceptanceProbe: "probes/hazard-recovery.spec.ts",
      maxLostProgressSeconds: 25,
      softlockPossible: false,
    },
    {
      failureMode: "arena-escape",
      recoveryPath: "arena gate re-closes and the player is pushed back inside the bounds",
      resetPath: "arena encounter restarts at the arena entry checkpoint",
      acceptanceProbe: "probes/arena-containment.spec.ts",
      maxLostProgressSeconds: 40,
      softlockPossible: false,
    },
    {
      failureMode: "checkpoint-miss",
      recoveryPath: "previous checkpoint anchor remains valid",
      resetPath: "respawn at the previous checkpoint anchor",
      acceptanceProbe: "probes/checkpoint-fallback.spec.ts",
      maxLostProgressSeconds: 60,
      softlockPossible: false,
    },
    {
      failureMode: "boss-phase-stall",
      recoveryPath: "boss re-telegraphs the counter window on a bounded timer",
      resetPath: "boss encounter restarts from the arena entry checkpoint",
      acceptanceProbe: "probes/boss-phase-recovery.spec.ts",
      maxLostProgressSeconds: 90,
      softlockPossible: false,
    },
  ],
  maxLostProgressSecondsBudget: 120,
};

function axiomVeilModuleUnits(canonicalPerUnit: number, adapter: string | null): ModuleUnitDeclaration[] {
  const spatial = AXIOM_VEIL_METRIC_MODULES.map<ModuleUnitDeclaration>((module) => ({
    module,
    dimension: "spatial",
    unit: canonicalPerUnit === 1 ? "world-unit" : "metre",
    canonicalPerUnit,
    adapter,
  }));
  const world: ModuleUnitDeclaration[] = [
    { module: "world", dimension: "spatial", unit: "world-unit", canonicalPerUnit: 1, adapter: null },
    { module: "renderer", dimension: "render", unit: "device-pixel", canonicalPerUnit: 1, adapter: null },
    { module: "renderer", dimension: "camera", unit: "world-unit", canonicalPerUnit: 1, adapter: null },
    { module: "world", dimension: "collision", unit: "world-unit", canonicalPerUnit: 1, adapter: null },
    { module: "world", dimension: "checkpoint", unit: "world-unit", canonicalPerUnit: 1, adapter: null },
    { module: "simulation", dimension: "temporal", unit: "second", canonicalPerUnit: 1, adapter: null },
    { module: "input", dimension: "input", unit: "action-event", canonicalPerUnit: 1, adapter: null },
    { module: "combat", dimension: "health", unit: "hit-point", canonicalPerUnit: 1, adapter: null },
    { module: "combat", dimension: "damage", unit: "hit-point", canonicalPerUnit: 1, adapter: null },
  ];
  return [...spatial, ...world];
}

export const AXIOM_VEIL_40X_MISMATCH_FIXTURE: GameSeedDimensionalContract = {
  ...AXIOM_VEIL_BASE_SEED,
  moduleUnits: axiomVeilModuleUnits(40, null),
};

export const AXIOM_VEIL_ADAPTED_FIXTURE: GameSeedDimensionalContract = {
  ...AXIOM_VEIL_BASE_SEED,
  moduleUnits: axiomVeilModuleUnits(40, "metresToWorldUnits"),
};

export const AXIOM_VEIL_CANONICAL_FIXTURE: GameSeedDimensionalContract = {
  ...AXIOM_VEIL_BASE_SEED,
  moduleUnits: axiomVeilModuleUnits(1, null),
};
