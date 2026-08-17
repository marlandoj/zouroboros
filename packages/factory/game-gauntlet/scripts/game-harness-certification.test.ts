import { describe, expect, test } from "bun:test";
import {
  evaluateGameGauntletTerminalState,
  type GameGauntletDecisionInput,
} from "./game-gauntlet-contract";
import {
  AXIOM_VEIL_CERTIFIED_HARNESS,
  AXIOM_VEIL_EXPECTED_TRANSITIONS,
  AXIOM_VEIL_FROZEN_TITLE_FIXTURE,
  AXIOM_VEIL_HARNESS_BINDINGS,
  AXIOM_VEIL_INVALID_START_STATE_FIXTURE,
  AXIOM_VEIL_MUTABLE_BUILD_FIXTURE,
  AXIOM_VEIL_MUTATED_CONTROL_MAP_FIXTURE,
  AXIOM_VEIL_PINNED_CLOCK_FIXTURE,
  AXIOM_VEIL_PRODUCTION_INPUT_MAP,
  AXIOM_VEIL_REQUIRED_ACTIONS,
  AXIOM_VEIL_RUNTIME_IDENTITY,
  AXIOM_VEIL_STALE_CONTROLS_FIXTURE,
  AXIOM_VEIL_UNREACHABLE_SCENARIO_FIXTURE,
  AXIOM_VEIL_UNRECORDED_RUNTIME_FIXTURE,
  CERTIFIED_BINDING_SOURCE,
  GAME_HARNESS_CONTRACT_VERSION,
  GameHarnessCertificationViolation,
  HARNESS_CERTIFICATION_CHECKS,
  HARNESS_CERTIFIED_VERDICT,
  HARNESS_NOT_CERTIFIED_VERDICT,
  assertHarnessCertified,
  certifyHarness,
  computeInputMapDigest,
  deriveHarnessBindings,
  freezeProductionInputMap,
  type HarnessCertificationInput,
  type HarnessViolationCode,
} from "./game-harness-certification";

function codes(input: HarnessCertificationInput): HarnessViolationCode[] {
  return certifyHarness(input).violations.map((violation) => violation.code);
}

function failedChecks(input: HarnessCertificationInput): string[] {
  const decision = certifyHarness(input);
  return Object.entries(decision.checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check);
}

describe("production input map derivation", () => {
  test("freezes a content-addressed map and derives every required binding from it", () => {
    expect(AXIOM_VEIL_PRODUCTION_INPUT_MAP.contractVersion).toBe(GAME_HARNESS_CONTRACT_VERSION);
    expect(AXIOM_VEIL_PRODUCTION_INPUT_MAP.digest).toBe(
      computeInputMapDigest(
        AXIOM_VEIL_PRODUCTION_INPUT_MAP.sourcePath,
        AXIOM_VEIL_PRODUCTION_INPUT_MAP.sourceSha256,
        AXIOM_VEIL_PRODUCTION_INPUT_MAP.entries,
      ),
    );
    expect(AXIOM_VEIL_HARNESS_BINDINGS).toHaveLength(AXIOM_VEIL_REQUIRED_ACTIONS.length);
    for (const binding of AXIOM_VEIL_HARNESS_BINDINGS) {
      expect(binding.source).toBe(CERTIFIED_BINDING_SOURCE);
      expect(binding.sourceDigest).toBe(AXIOM_VEIL_PRODUCTION_INPUT_MAP.digest);
    }
    expect(AXIOM_VEIL_HARNESS_BINDINGS.find((binding) => binding.action === "counter")?.binding).toBe("KeyJ");
  });

  test("the digest changes when a production binding changes", () => {
    const rebound = freezeProductionInputMap(
      AXIOM_VEIL_PRODUCTION_INPUT_MAP.sourcePath,
      "export const counter = 'KeyK';\n",
      AXIOM_VEIL_PRODUCTION_INPUT_MAP.entries.map((entry) =>
        entry.action === "counter" ? { ...entry, binding: "KeyK" } : entry,
      ),
    );
    expect(rebound.digest).not.toBe(AXIOM_VEIL_PRODUCTION_INPUT_MAP.digest);
    expect(rebound.sourceSha256).not.toBe(AXIOM_VEIL_PRODUCTION_INPUT_MAP.sourceSha256);
  });

  test("rejects a malformed, empty, or duplicated map and an unbindable required action", () => {
    expect(() => freezeProductionInputMap("src/input/controlMap.ts", "", [])).toThrow(
      GameHarnessCertificationViolation,
    );
    expect(() =>
      freezeProductionInputMap("src/input/controlMap.ts", "x", [
        { action: "counter", binding: "KeyJ", playerAvailable: true },
        { action: "counter", binding: "KeyK", playerAvailable: true },
      ]),
    ).toThrow(/duplicate-action/);
    expect(() => deriveHarnessBindings(AXIOM_VEIL_PRODUCTION_INPUT_MAP, ["dash"])).toThrow(
      /missing-required-action/,
    );
  });
});

describe("certified harness", () => {
  test("certifies the reference harness and permits critic dispatch", () => {
    const decision = certifyHarness(AXIOM_VEIL_CERTIFIED_HARNESS);
    expect(decision.verdict).toBe(HARNESS_CERTIFIED_VERDICT);
    expect(decision.certified).toBe(true);
    expect(decision.criticDispatchAllowed).toBe(true);
    expect(decision.scoresSuppressed).toBe(false);
    expect(decision.terminalState).toBeNull();
    expect(decision.violations).toEqual([]);
    expect(decision.blockedReasons).toEqual([]);
    for (const check of HARNESS_CERTIFICATION_CHECKS) {
      expect(decision.checks[check]).toBe(true);
    }
    expect(() => assertHarnessCertified(AXIOM_VEIL_CERTIFIED_HARNESS)).not.toThrow();
  });

  test("records viewport, device pixel ratio, renderer, driver, and build identity", () => {
    const decision = certifyHarness(AXIOM_VEIL_CERTIFIED_HARNESS);
    expect(decision.runtimeIdentity).toEqual(AXIOM_VEIL_RUNTIME_IDENTITY);
    expect(decision.runtimeIdentity.viewportWidth).toBeGreaterThan(0);
    expect(decision.runtimeIdentity.viewportHeight).toBeGreaterThan(0);
    expect(decision.runtimeIdentity.devicePixelRatio).toBeGreaterThan(0);
    expect(decision.runtimeIdentity.renderer.length).toBeGreaterThan(0);
    expect(decision.runtimeIdentity.driver.length).toBeGreaterThan(0);
    expect(decision.runtimeIdentity.buildDigest).toBe(AXIOM_VEIL_CERTIFIED_HARNESS.frozenBuild.buildDigest);
  });

  test("rejects an unknown contract version and a missing candidate identity", () => {
    expect(codes({ ...AXIOM_VEIL_CERTIFIED_HARNESS, contractVersion: 2 })).toContain("unknown-version");
    expect(codes({ ...AXIOM_VEIL_CERTIFIED_HARNESS, candidateId: "  " })).toContain(
      "candidate-identity-mismatch",
    );
  });
});

describe("frozen Axiom Veil preflight failures", () => {
  test("a title frozen at frame 0 fails dismissal, clock, start state, transitions, and reachability", () => {
    const decision = certifyHarness(AXIOM_VEIL_FROZEN_TITLE_FIXTURE);
    expect(decision.verdict).toBe(HARNESS_NOT_CERTIFIED_VERDICT);
    expect(decision.criticDispatchAllowed).toBe(false);
    expect(decision.scoresSuppressed).toBe(true);
    const violations = decision.violations.map((violation) => violation.code);
    expect(violations).toContain("title-not-dismissed");
    expect(violations).toContain("frame-not-advanced");
    expect(violations).toContain("clock-not-advanced");
    expect(violations).toContain("start-state-not-reached");
    expect(violations).toContain("not-grounded");
    expect(violations).toContain("missing-transition");
    expect(violations).toContain("scenario-unreachable");
    expect(failedChecks(AXIOM_VEIL_FROZEN_TITLE_FIXTURE).sort()).toEqual(
      ["action-transitions", "clock-advance", "scenario-reachability", "start-state", "title-dismissal"].sort(),
    );
  });

  test("a pinned simulation clock fails on its own", () => {
    const decision = certifyHarness(AXIOM_VEIL_PINNED_CLOCK_FIXTURE);
    expect(decision.certified).toBe(false);
    expect(failedChecks(AXIOM_VEIL_PINNED_CLOCK_FIXTURE)).toEqual(["clock-advance"]);
    expect(decision.violations.map((violation) => violation.code).sort()).toEqual([
      "clock-not-advanced",
      "frame-not-advanced",
    ]);
  });

  test("a stale critic-brief control binding is rejected as not derived from production", () => {
    const violations = codes(AXIOM_VEIL_STALE_CONTROLS_FIXTURE);
    expect(violations).toContain("binding-not-derived");
    expect(violations).toContain("binding-source-digest-mismatch");
    expect(violations).toContain("stale-binding");
    expect(failedChecks(AXIOM_VEIL_STALE_CONTROLS_FIXTURE)).toEqual(["production-input-map"]);
  });

  test("a control map mutated outside the frozen manifest is rejected", () => {
    expect(codes(AXIOM_VEIL_MUTATED_CONTROL_MAP_FIXTURE)).toContain("control-map-digest-mismatch");
    expect(
      codes({
        ...AXIOM_VEIL_CERTIFIED_HARNESS,
        productionInputMap: freezeProductionInputMap(
          "src/input/legacyControlMap.ts",
          "export const counter = 'KeyJ';\n",
          AXIOM_VEIL_PRODUCTION_INPUT_MAP.entries,
        ),
      }),
    ).toContain("control-map-not-governed");
  });

  test("an unreachable rubric scenario blocks dispatch", () => {
    const decision = certifyHarness(AXIOM_VEIL_UNREACHABLE_SCENARIO_FIXTURE);
    expect(decision.certified).toBe(false);
    expect(failedChecks(AXIOM_VEIL_UNREACHABLE_SCENARIO_FIXTURE)).toEqual(["scenario-reachability"]);
    expect(decision.blockedReasons.join("\n")).toContain("counter-damage");
    expect(
      codes({
        ...AXIOM_VEIL_CERTIFIED_HARNESS,
        rubricScenarios: ["route-to-boss", "counter-damage", "boss-victory"],
      }),
    ).toContain("missing-scenario-probe");
  });

  test("an ungrounded or wrong start state blocks dispatch", () => {
    const violations = codes(AXIOM_VEIL_INVALID_START_STATE_FIXTURE);
    expect(violations).toContain("start-state-not-reached");
    expect(violations).toContain("not-grounded");
    expect(failedChecks(AXIOM_VEIL_INVALID_START_STATE_FIXTURE)).toEqual(["start-state"]);
  });

  test("unrecorded runtime identity blocks dispatch", () => {
    const violations = codes(AXIOM_VEIL_UNRECORDED_RUNTIME_FIXTURE);
    expect(violations).toContain("missing-runtime-identity");
    expect(violations).toContain("invalid-viewport");
    expect(violations).toContain("invalid-device-pixel-ratio");
    expect(failedChecks(AXIOM_VEIL_UNRECORDED_RUNTIME_FIXTURE)).toEqual(["runtime-identity"]);
  });

  test("a mutable or mismatched build blocks dispatch", () => {
    expect(codes(AXIOM_VEIL_MUTABLE_BUILD_FIXTURE)).toContain("build-not-frozen");
    expect(
      codes({
        ...AXIOM_VEIL_CERTIFIED_HARNESS,
        runtimeIdentity: { ...AXIOM_VEIL_RUNTIME_IDENTITY, buildDigest: "sha256:hot-reloaded-build" },
      }),
    ).toContain("build-identity-mismatch");
  });

  test("a missing or unexpected action transition blocks dispatch", () => {
    const missing = certifyHarness({
      ...AXIOM_VEIL_CERTIFIED_HARNESS,
      observation: {
        ...AXIOM_VEIL_CERTIFIED_HARNESS.observation,
        transitions: AXIOM_VEIL_CERTIFIED_HARNESS.observation.transitions.filter(
          (transition) => transition.action !== "counter",
        ),
      },
    });
    expect(missing.violations.map((violation) => violation.code)).toContain("missing-transition");

    const unexpected = certifyHarness({
      ...AXIOM_VEIL_CERTIFIED_HARNESS,
      observation: {
        ...AXIOM_VEIL_CERTIFIED_HARNESS.observation,
        transitions: AXIOM_VEIL_CERTIFIED_HARNESS.observation.transitions.map((transition) =>
          transition.action === "counter"
            ? { ...transition, toState: "boss-approach", frameAdvance: 0 }
            : transition,
        ),
      },
    });
    const codesForUnexpected = unexpected.violations.map((violation) => violation.code);
    expect(codesForUnexpected).toContain("unexpected-transition");
    expect(codesForUnexpected).toContain("frame-not-advanced");
    expect(AXIOM_VEIL_EXPECTED_TRANSITIONS).toHaveLength(AXIOM_VEIL_REQUIRED_ACTIONS.length);
  });

  test("a debug-only action cannot dismiss the title", () => {
    const debugDismissal = certifyHarness({
      ...AXIOM_VEIL_CERTIFIED_HARNESS,
      bindings: [
        ...AXIOM_VEIL_HARNESS_BINDINGS,
        {
          action: "debug-teleport",
          binding: "F9",
          source: CERTIFIED_BINDING_SOURCE,
          sourceDigest: AXIOM_VEIL_PRODUCTION_INPUT_MAP.digest,
          playerAvailable: false,
        },
      ],
      observation: { ...AXIOM_VEIL_CERTIFIED_HARNESS.observation, titleDismissedBy: "debug-teleport" },
    });
    expect(debugDismissal.violations.map((violation) => violation.code)).toContain("title-action-unavailable");

    const unboundDismissal = certifyHarness({
      ...AXIOM_VEIL_CERTIFIED_HARNESS,
      observation: { ...AXIOM_VEIL_CERTIFIED_HARNESS.observation, titleDismissedBy: "dash" },
    });
    expect(unboundDismissal.violations.map((violation) => violation.code)).toContain("title-action-unbound");
  });
});

describe("fail-closed contract", () => {
  const uncertifiedFixtures: readonly (readonly [string, HarnessCertificationInput])[] = [
    ["frozen-title", AXIOM_VEIL_FROZEN_TITLE_FIXTURE],
    ["pinned-clock", AXIOM_VEIL_PINNED_CLOCK_FIXTURE],
    ["stale-controls", AXIOM_VEIL_STALE_CONTROLS_FIXTURE],
    ["mutated-control-map", AXIOM_VEIL_MUTATED_CONTROL_MAP_FIXTURE],
    ["unreachable-scenario", AXIOM_VEIL_UNREACHABLE_SCENARIO_FIXTURE],
    ["invalid-start-state", AXIOM_VEIL_INVALID_START_STATE_FIXTURE],
    ["unrecorded-runtime", AXIOM_VEIL_UNRECORDED_RUNTIME_FIXTURE],
    ["mutable-build", AXIOM_VEIL_MUTABLE_BUILD_FIXTURE],
  ];

  test("every failing preflight returns HARNESS_NOT_CERTIFIED and suppresses dispatch and scores", () => {
    for (const [label, fixture] of uncertifiedFixtures) {
      const decision = certifyHarness(fixture);
      expect(`${label}:${decision.verdict}`).toBe(`${label}:${HARNESS_NOT_CERTIFIED_VERDICT}`);
      expect(decision.certified).toBe(false);
      expect(decision.criticDispatchAllowed).toBe(false);
      expect(decision.scoresSuppressed).toBe(true);
      expect(decision.terminalState).toBe("BLOCKED");
      expect(decision.blockedReasons.length).toBeGreaterThan(0);
      expect(() => assertHarnessCertified(fixture)).toThrow(GameHarnessCertificationViolation);
    }
  });

  test("an uncertified harness can never reach SUCCESS in the GLA-01 state contract", () => {
    const round: GameGauntletDecisionInput = {
      contractVersion: 1,
      phase: "RECORD",
      canceled: false,
      authorityGranted: true,
      approvalRequired: false,
      blockedReasons: certifyHarness(AXIOM_VEIL_FROZEN_TITLE_FIXTURE).blockedReasons,
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
      candidateHash: "sha256:candidate",
      incumbentHash: "sha256:incumbent",
      rollbackReference: "git:refs/tags/axiom-veil-slice-0003",
    };
    expect(evaluateGameGauntletTerminalState(round)).toBe("BLOCKED");
    expect(
      evaluateGameGauntletTerminalState({
        ...round,
        blockedReasons: certifyHarness(AXIOM_VEIL_CERTIFIED_HARNESS).blockedReasons,
      }),
    ).toBe("SUCCESS");
  });
});
