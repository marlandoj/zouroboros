import { describe, expect, test } from "bun:test";
import {
  GAME_GAUNTLET_CONTRACT_VERSION,
  evaluateGameGauntletTerminalState,
  type GameGauntletDecisionInput,
} from "./game-gauntlet-contract";
import {
  ALLOWED_UNITS,
  AXIOM_VEIL_40X_MISMATCH_FIXTURE,
  AXIOM_VEIL_ADAPTED_FIXTURE,
  AXIOM_VEIL_CANONICAL_FIXTURE,
  CANONICAL_UNITS,
  GAME_SEED_CONTRACT_VERSION,
  GAME_SEED_DIMENSIONS,
  GAME_SEED_GATE_STAGES,
  GameSeedContractViolation,
  REQUIRED_RATIO_PROBES,
  TEACHING_STAGES,
  assertGameSeedContract,
  collectUnitScaleMismatches,
  evaluateGameSeedContract,
  gateEveryGameSeedStage,
  gateGameSeedDispatch,
  type GameSeedDimensionalContract,
  type GameSeedViolationCode,
  type InteractionCapability,
  type ModuleUnitDeclaration,
  type ProgressionTeachingEntry,
  type RatioProbeDeclaration,
  type RecoveryMatrixEntry,
} from "./game-seed-contract";

function seed(overrides: Partial<GameSeedDimensionalContract> = {}): GameSeedDimensionalContract {
  return { ...AXIOM_VEIL_CANONICAL_FIXTURE, ...overrides };
}

function codes(target: GameSeedDimensionalContract): GameSeedViolationCode[] {
  return evaluateGameSeedContract(target).violations.map((violation) => violation.code);
}

function withModuleUnit(extra: ModuleUnitDeclaration): GameSeedDimensionalContract {
  return seed({ moduleUnits: [...AXIOM_VEIL_CANONICAL_FIXTURE.moduleUnits, extra] });
}

function withProbe(probe: RatioProbeDeclaration): GameSeedDimensionalContract {
  return seed({
    ratioProbes: AXIOM_VEIL_CANONICAL_FIXTURE.ratioProbes.map((existing) =>
      existing.probe === probe.probe ? probe : existing,
    ),
  });
}

function withInteraction(overrides: Partial<InteractionCapability>): GameSeedDimensionalContract {
  const [first, ...rest] = AXIOM_VEIL_CANONICAL_FIXTURE.interactions;
  if (first === undefined) throw new Error("fixture must declare at least one interaction");
  return seed({ interactions: [{ ...first, ...overrides }, ...rest] });
}

function withProgression(verb: string, overrides: Partial<ProgressionTeachingEntry>): GameSeedDimensionalContract {
  return seed({
    progression: AXIOM_VEIL_CANONICAL_FIXTURE.progression.map((entry) =>
      entry.verb === verb ? { ...entry, ...overrides } : entry,
    ),
  });
}

function withRecovery(failureMode: string, overrides: Partial<RecoveryMatrixEntry>): GameSeedDimensionalContract {
  return seed({
    recovery: AXIOM_VEIL_CANONICAL_FIXTURE.recovery.map((entry) =>
      entry.failureMode === failureMode ? { ...entry, ...overrides } : entry,
    ),
  });
}

describe("canonical dimensional vocabulary", () => {
  test("declares the nine canonical seed dimensions with a canonical unit each", () => {
    expect(GAME_SEED_DIMENSIONS).toEqual([
      "spatial",
      "temporal",
      "input",
      "health",
      "damage",
      "camera",
      "render",
      "collision",
      "checkpoint",
    ]);
    for (const dimension of GAME_SEED_DIMENSIONS) {
      const canonical: string = CANONICAL_UNITS[dimension];
      const allowed: readonly string[] = ALLOWED_UNITS[dimension];
      expect(allowed).toContain(canonical);
    }
  });

  test("declares the seven pre-parallel ratio smokes and the four teaching stages", () => {
    expect(REQUIRED_RATIO_PROBES).toEqual([
      "viewport-to-player-height",
      "room-width-to-run-speed",
      "jump-height-to-platform-rise",
      "projectile-reach-to-player-width",
      "health-to-damage-scale",
      "checkpoint-radius",
      "arena-bounds",
    ]);
    expect(TEACHING_STAGES).toEqual(["teach", "safe-practice", "test", "combine"]);
  });

  test("a fully declared seed passes and clears both dispatch stages", () => {
    const report = evaluateGameSeedContract(AXIOM_VEIL_CANONICAL_FIXTURE);
    expect(report.valid).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.blockedReasons).toEqual([]);
    expect(() => assertGameSeedContract(AXIOM_VEIL_CANONICAL_FIXTURE)).not.toThrow();

    const decisions = gateEveryGameSeedStage(AXIOM_VEIL_CANONICAL_FIXTURE);
    expect(decisions.map((decision) => decision.stage)).toEqual([...GAME_SEED_GATE_STAGES]);
    for (const decision of decisions) {
      expect(decision.allowed).toBe(true);
      expect(decision.terminalState).toBeNull();
    }
  });
});

describe("frozen Axiom Veil 40x mismatch fixture", () => {
  test("fails closed with an exact 40x ratio on every metric simulation module", () => {
    const report = evaluateGameSeedContract(AXIOM_VEIL_40X_MISMATCH_FIXTURE);
    expect(report.valid).toBe(false);

    const mismatchViolations = report.violations.filter((violation) => violation.code === "unit-scale-mismatch");
    expect(mismatchViolations).toHaveLength(5);
    expect(mismatchViolations.map((violation) => violation.subject).sort()).toEqual([
      "boss:spatial",
      "camera:spatial",
      "combat:spatial",
      "enemies:spatial",
      "player:spatial",
    ]);

    const mismatches = collectUnitScaleMismatches(AXIOM_VEIL_40X_MISMATCH_FIXTURE);
    expect(mismatches).toHaveLength(5);
    for (const mismatch of mismatches) {
      expect(mismatch.ratio).toBe(40);
      expect(mismatch.moduleUnit).toBe("metre");
      expect(mismatch.basisUnit).toBe("world-unit");
    }
  });

  test("fails before parallel implementation and before critic dispatch", () => {
    for (const stage of GAME_SEED_GATE_STAGES) {
      const decision = gateGameSeedDispatch(AXIOM_VEIL_40X_MISMATCH_FIXTURE, stage);
      expect(decision.allowed).toBe(false);
      expect(decision.terminalState).toBe("BLOCKED");
      expect(decision.report.blockedReasons.length).toBeGreaterThan(0);
    }
    expect(() => assertGameSeedContract(AXIOM_VEIL_40X_MISMATCH_FIXTURE)).toThrow(GameSeedContractViolation);
  });

  test("the same 40x scale passes only through a declared named adapter", () => {
    const report = evaluateGameSeedContract(AXIOM_VEIL_ADAPTED_FIXTURE);
    expect(report.valid).toBe(true);
    expect(report.unitScaleMismatches).toHaveLength(5);
    expect(report.unitScaleMismatches.every((mismatch) => mismatch.ratio === 40)).toBe(true);

    const undeclared = seed({
      moduleUnits: AXIOM_VEIL_ADAPTED_FIXTURE.moduleUnits.map((declaration) =>
        declaration.adapter === null ? declaration : { ...declaration, adapter: "adhocScale" },
      ),
    });
    expect(codes(undeclared)).toContain("unknown-adapter");
  });

  test("a blocked seed can never be laundered into a Gauntlet SUCCESS", () => {
    const report = evaluateGameSeedContract(AXIOM_VEIL_40X_MISMATCH_FIXTURE);
    const input: GameGauntletDecisionInput = {
      contractVersion: GAME_GAUNTLET_CONTRACT_VERSION,
      phase: "RECORD",
      canceled: false,
      authorityGranted: true,
      approvalRequired: false,
      blockedReasons: report.blockedReasons,
      limitsExhausted: false,
      evidenceValid: true,
      observationGapPresent: true,
      protectedGateRegressed: false,
      sameStrategyFailures: 0,
      sameRootGapSurvivals: 0,
      distinctStrategiesRemain: true,
      requiredLensesPass: true,
      postFlightPass: true,
      gapAudit: {
        reachability: true,
        "data-prerequisites": true,
        "cross-boundary-state": true,
        "eval-production-parity": true,
        "dangling-identifiers": true,
      },
      severityOneIssues: 0,
      roundRecorded: true,
      candidateHash: "candidate-sha256",
      incumbentHash: "incumbent-sha256",
      rollbackReference: "refs/gauntlet/incumbent-sha256",
    };
    expect(evaluateGameGauntletTerminalState(input)).toBe("BLOCKED");
  });
});

describe("unit declarations fail closed", () => {
  test("rejects an unknown seed contract version without further parsing", () => {
    const report = evaluateGameSeedContract(seed({ contractVersion: GAME_SEED_CONTRACT_VERSION + 1 }));
    expect(report.valid).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.code).toBe("unknown-version");
  });

  test("rejects unknown dimensions, unknown units, and non-positive scales", () => {
    const unknownDimension = withModuleUnit({
      module: "audio",
      dimension: "acoustic" as GameSeedDimensionalContract["unitBasis"][number]["dimension"],
      unit: "world-unit",
      canonicalPerUnit: 1,
      adapter: null,
    });
    expect(codes(unknownDimension)).toContain("unknown-dimension");

    const unknownUnit = withModuleUnit({
      module: "player",
      dimension: "spatial",
      unit: "furlong",
      canonicalPerUnit: 1,
      adapter: null,
    });
    expect(codes(unknownUnit)).toContain("unknown-unit");

    const badScale = withModuleUnit({
      module: "player",
      dimension: "spatial",
      unit: "metre",
      canonicalPerUnit: 0,
      adapter: "metresToWorldUnits",
    });
    expect(codes(badScale)).toContain("invalid-scale");
  });

  test("requires all nine dimensions in the seed basis", () => {
    for (const dimension of GAME_SEED_DIMENSIONS) {
      const missing = seed({
        unitBasis: AXIOM_VEIL_CANONICAL_FIXTURE.unitBasis.filter((entry) => entry.dimension !== dimension),
      });
      const violations = evaluateGameSeedContract(missing).violations;
      expect(violations.some((violation) => violation.code === "missing-dimension" && violation.subject === dimension)).toBe(
        true,
      );
    }
  });

  test("rejects a unit whose scale is declared inconsistently across modules", () => {
    const inconsistent = seed({
      moduleUnits: [
        ...AXIOM_VEIL_ADAPTED_FIXTURE.moduleUnits,
        {
          module: "hud",
          dimension: "spatial",
          unit: "metre",
          canonicalPerUnit: 100,
          adapter: "metresToWorldUnits",
        },
      ],
    });
    expect(codes(inconsistent)).toContain("inconsistent-unit-scale");
  });
});

describe("pre-parallel ratio smokes", () => {
  test("every required probe must be declared", () => {
    for (const required of REQUIRED_RATIO_PROBES) {
      const missing = seed({
        ratioProbes: AXIOM_VEIL_CANONICAL_FIXTURE.ratioProbes.filter((probe) => probe.probe !== required),
      });
      const violations = evaluateGameSeedContract(missing).violations;
      expect(
        violations.some((violation) => violation.code === "missing-ratio-probe" && violation.subject === required),
      ).toBe(true);
    }
  });

  test("a 180-unit jump against a 208-unit mandatory rise is out of band", () => {
    const impossibleRoute = withProbe({
      probe: "jump-height-to-platform-rise",
      measured: 180 / 208,
      expectedMin: 1.05,
      expectedMax: 2,
    });
    expect(codes(impossibleRoute)).toContain("ratio-out-of-band");
  });

  test("rejects malformed probe bounds", () => {
    const malformed = withProbe({
      probe: "arena-bounds",
      measured: Number.NaN,
      expectedMin: 1.1,
      expectedMax: 3,
    });
    expect(codes(malformed)).toContain("invalid-scale");

    const inverted = withProbe({
      probe: "arena-bounds",
      measured: 1.4,
      expectedMin: 3,
      expectedMax: 1.1,
    });
    expect(codes(inverted)).toContain("invalid-scale");
  });
});

describe("interaction responsibility matrix", () => {
  test("requires producer, consumer, trigger, consequence, and acceptance probe", () => {
    const fields: ReadonlyArray<keyof InteractionCapability> = [
      "producer",
      "consumer",
      "trigger",
      "consequence",
      "acceptanceProbe",
    ];
    for (const field of fields) {
      const incomplete = withInteraction({ [field]: "  " } as Partial<InteractionCapability>);
      const violations = evaluateGameSeedContract(incomplete).violations;
      expect(
        violations.some(
          (violation) =>
            violation.code === "missing-interaction-ownership" && violation.subject.endsWith(`.${field}`),
        ),
      ).toBe(true);
    }
  });

  test("rejects duplicate capability ids and test-only consumers", () => {
    const [first] = AXIOM_VEIL_CANONICAL_FIXTURE.interactions;
    if (first === undefined) throw new Error("fixture must declare at least one interaction");
    const duplicated = seed({ interactions: [...AXIOM_VEIL_CANONICAL_FIXTURE.interactions, first] });
    expect(codes(duplicated)).toContain("duplicate-capability");

    const testOnly = withInteraction({ consumerKind: "test-only" });
    expect(codes(testOnly)).toContain("non-production-consumer");
  });
});

describe("progression teaching matrix", () => {
  test("an untaught mandatory verb fails closed", () => {
    const untaught = seed({
      progression: AXIOM_VEIL_CANONICAL_FIXTURE.progression.filter((entry) => entry.verb !== "wall-jump"),
    });
    const violations = evaluateGameSeedContract(untaught).violations;
    expect(
      violations.some((violation) => violation.code === "untaught-mandatory-verb" && violation.subject === "wall-jump"),
    ).toBe(true);
  });

  test("mandatory use before the test stage fails closed", () => {
    const premature = withProgression("wall-jump", { firstMandatoryUseAt: 5 });
    expect(codes(premature)).toContain("untaught-mandatory-verb");
  });

  test("stages must strictly increase through teach, safe practice, test, and combine", () => {
    const outOfOrder = withProgression("jump", { safePracticeAt: 1, teachAt: 1 });
    expect(codes(outOfOrder)).toContain("incomplete-teaching-sequence");

    const fractional = withProgression("jump", { testAt: 2.5 });
    expect(codes(fractional)).toContain("incomplete-teaching-sequence");
  });
});

describe("recovery and reset matrix", () => {
  test("every declared failure mode needs a recovery entry", () => {
    const uncovered = seed({
      recovery: AXIOM_VEIL_CANONICAL_FIXTURE.recovery.filter((entry) => entry.failureMode !== "boss-phase-stall"),
    });
    const violations = evaluateGameSeedContract(uncovered).violations;
    expect(
      violations.some(
        (violation) =>
          violation.code === "missing-recovery-entry" && violation.subject.endsWith(":boss-phase-stall"),
      ),
    ).toBe(true);
  });

  test("a permanent stalemate is never an acceptable failure mode", () => {
    const stalemate = withRecovery("boss-phase-stall", { softlockPossible: true });
    expect(codes(stalemate)).toContain("unrecoverable-failure-mode");
  });

  test("recovery paths and bounded lost progress are mandatory", () => {
    const noReset = withRecovery("hazard-death", { resetPath: "" });
    expect(codes(noReset)).toContain("missing-recovery-path");

    const overBudget = withRecovery("hazard-death", { maxLostProgressSeconds: 900 });
    expect(codes(overBudget)).toContain("recovery-budget-exceeded");

    const unbounded = withRecovery("hazard-death", { maxLostProgressSeconds: Number.POSITIVE_INFINITY });
    expect(codes(unbounded)).toContain("recovery-budget-exceeded");
  });
});
