import { describe, expect, test } from "bun:test";
import {
  GAME_GAUNTLET_CONTRACT_VERSION,
  GAME_GAUNTLET_GAP_AUDIT_CHECKS,
  GAME_GAUNTLET_PHASES,
  GAME_GAUNTLET_TERMINAL_STATES,
  GameGauntletContractViolation,
  assertGameGauntletContractVersion,
  assertGameGauntletTransition,
  canGameGauntletTransition,
  evaluateGameGauntletTerminalState,
  finalizeGameGauntletRound,
  gapAuditPasses,
  isCompleteGapAuditEvidence,
  type GameGauntletDecisionInput,
  type GameGauntletGapAuditEvidence,
  type GameGauntletTerminalState,
} from "./game-gauntlet-contract";

const PASSING_GAP_AUDIT: GameGauntletGapAuditEvidence = {
  reachability: true,
  "data-prerequisites": true,
  "cross-boundary-state": true,
  "eval-production-parity": true,
  "dangling-identifiers": true,
};

function validInput(overrides: Partial<GameGauntletDecisionInput> = {}): GameGauntletDecisionInput {
  return {
    contractVersion: GAME_GAUNTLET_CONTRACT_VERSION,
    phase: "RECORD",
    canceled: false,
    authorityGranted: true,
    approvalRequired: false,
    blockedReasons: [],
    limitsExhausted: false,
    evidenceValid: true,
    observationGapPresent: true,
    protectedGateRegressed: false,
    sameStrategyFailures: 0,
    sameRootGapSurvivals: 0,
    distinctStrategiesRemain: true,
    requiredLensesPass: true,
    postFlightPass: true,
    gapAudit: PASSING_GAP_AUDIT,
    severityOneIssues: 0,
    roundRecorded: true,
    candidateHash: "candidate-sha256",
    incumbentHash: "incumbent-sha256",
    rollbackReference: "refs/gauntlet/incumbent-sha256",
    ...overrides,
  };
}

const TERMINAL_FIXTURES: ReadonlyArray<[
  GameGauntletTerminalState,
  Partial<GameGauntletDecisionInput>,
]> = [
  ["SUCCESS", {}],
  ["CLEAN_NOOP", { observationGapPresent: false }],
  ["INVALID_EVIDENCE", { evidenceValid: false }],
  ["REGRESSED", { protectedGateRegressed: true }],
  ["STRATEGY_REVIEW", { sameStrategyFailures: 2 }],
  ["STAGNATED", { distinctStrategiesRemain: false }],
  ["EXHAUSTED", { limitsExhausted: true }],
  ["APPROVAL_REQUIRED", { authorityGranted: false }],
  ["BLOCKED", { blockedReasons: ["target renderer unavailable"] }],
  ["ABORTED", { canceled: true }],
];

describe("versioned contract and state graph", () => {
  test("encodes the five ordered phases and exactly ten terminal states", () => {
    expect(GAME_GAUNTLET_PHASES).toEqual(["OBSERVE", "CHOOSE", "ACT", "VERIFY", "RECORD"]);
    expect(GAME_GAUNTLET_TERMINAL_STATES).toEqual([
      "SUCCESS",
      "CLEAN_NOOP",
      "INVALID_EVIDENCE",
      "REGRESSED",
      "STRATEGY_REVIEW",
      "STAGNATED",
      "EXHAUSTED",
      "APPROVAL_REQUIRED",
      "BLOCKED",
      "ABORTED",
    ]);
  });

  test("permits only the ordered active path to SUCCESS", () => {
    expect(canGameGauntletTransition("OBSERVE", "CHOOSE")).toBe(true);
    expect(canGameGauntletTransition("CHOOSE", "ACT")).toBe(true);
    expect(canGameGauntletTransition("ACT", "VERIFY")).toBe(true);
    expect(canGameGauntletTransition("VERIFY", "RECORD")).toBe(true);
    expect(canGameGauntletTransition("RECORD", "SUCCESS")).toBe(true);
    expect(canGameGauntletTransition("OBSERVE", "SUCCESS")).toBe(false);
    expect(canGameGauntletTransition("ACT", "SUCCESS")).toBe(false);
  });

  test("makes every terminal state reachable and absorbing", () => {
    for (const terminal of GAME_GAUNTLET_TERMINAL_STATES) {
      expect(canGameGauntletTransition("RECORD", terminal)).toBe(true);
      for (const state of [...GAME_GAUNTLET_PHASES, ...GAME_GAUNTLET_TERMINAL_STATES]) {
        expect(canGameGauntletTransition(terminal, state)).toBe(false);
      }
    }
  });

  test("fails closed on unknown versions, states, and transitions", () => {
    expect(() => assertGameGauntletContractVersion(2)).toThrow(GameGauntletContractViolation);
    expect(() => assertGameGauntletTransition("UNKNOWN", "ACT")).toThrow(GameGauntletContractViolation);
    expect(() => assertGameGauntletTransition("OBSERVE", "VERIFY")).toThrow(GameGauntletContractViolation);
    expect(canGameGauntletTransition("UNKNOWN", "SUCCESS")).toBe(false);
  });
});

describe("gap-audit alignment", () => {
  test("requires exactly the existing five gap-audit dimensions", () => {
    expect(GAME_GAUNTLET_GAP_AUDIT_CHECKS).toEqual([
      "reachability",
      "data-prerequisites",
      "cross-boundary-state",
      "eval-production-parity",
      "dangling-identifiers",
    ]);
    expect(isCompleteGapAuditEvidence(PASSING_GAP_AUDIT)).toBe(true);
    expect(gapAuditPasses(PASSING_GAP_AUDIT)).toBe(true);
    expect(isCompleteGapAuditEvidence({ ...PASSING_GAP_AUDIT, extra: true })).toBe(false);
    expect(isCompleteGapAuditEvidence({ reachability: true })).toBe(false);
  });

  test("one failed gap-audit dimension prevents SUCCESS", () => {
    for (const check of GAME_GAUNTLET_GAP_AUDIT_CHECKS) {
      const gapAudit = { ...PASSING_GAP_AUDIT, [check]: false };
      expect(evaluateGameGauntletTerminalState(validInput({ gapAudit }))).toBe("BLOCKED");
    }
  });
});

describe("terminal decision", () => {
  test("fixtures reach every terminal state", () => {
    const reached = new Set<GameGauntletTerminalState>();
    for (const [expected, overrides] of TERMINAL_FIXTURES) {
      const actual = evaluateGameGauntletTerminalState(validInput(overrides));
      expect(actual).toBe(expected);
      reached.add(actual);
    }
    expect([...reached].sort()).toEqual([...GAME_GAUNTLET_TERMINAL_STATES].sort());
  });

  test("missing authority or evidence can never yield SUCCESS", () => {
    const degraded: Partial<GameGauntletDecisionInput>[] = [
      { authorityGranted: false },
      { approvalRequired: true },
      { evidenceValid: false },
      { gapAudit: null },
      { candidateHash: "" },
      { incumbentHash: "" },
      { rollbackReference: "" },
      { roundRecorded: false },
      { requiredLensesPass: false },
      { postFlightPass: false },
      { severityOneIssues: 1 },
    ];
    for (const override of degraded) {
      expect(evaluateGameGauntletTerminalState(validInput(override))).not.toBe("SUCCESS");
    }
  });

  test("SUCCESS is unavailable before Record", () => {
    for (const phase of ["OBSERVE", "CHOOSE", "ACT", "VERIFY"] as const) {
      expect(evaluateGameGauntletTerminalState(validInput({ phase }))).toBe("BLOCKED");
    }
  });
});

describe("promotion and rollback", () => {
  test("promotes only a fully verified SUCCESS candidate", () => {
    const result = finalizeGameGauntletRound(validInput());
    expect(result).toEqual({
      terminalState: "SUCCESS",
      promoteCandidate: true,
      restoreIncumbent: false,
      incumbentHash: "candidate-sha256",
      rollbackReference: "refs/gauntlet/incumbent-sha256",
    });
  });

  test("every non-success state preserves the verified incumbent", () => {
    for (const [terminalState, overrides] of TERMINAL_FIXTURES.filter(([state]) => state !== "SUCCESS")) {
      const result = finalizeGameGauntletRound(validInput(overrides));
      expect(result.terminalState).toBe(terminalState);
      expect(result.promoteCandidate).toBe(false);
      expect(result.incumbentHash).toBe("incumbent-sha256");
      expect(result.rollbackReference).toBe("refs/gauntlet/incumbent-sha256");
    }
  });

  test("REGRESSED restores the incumbent", () => {
    const result = finalizeGameGauntletRound(validInput({ protectedGateRegressed: true }));
    expect(result.terminalState).toBe("REGRESSED");
    expect(result.restoreIncumbent).toBe(true);
    expect(result.incumbentHash).toBe("incumbent-sha256");
  });

  test("an impossible phase-to-terminal edge fails closed as BLOCKED", () => {
    const result = finalizeGameGauntletRound(validInput({ phase: "OBSERVE", protectedGateRegressed: true }));
    expect(result.terminalState).toBe("BLOCKED");
    expect(result.promoteCandidate).toBe(false);
  });

  test("a terminal record cannot omit incumbent or rollback references", () => {
    expect(() => finalizeGameGauntletRound(validInput({ incumbentHash: "" }))).toThrow(
      GameGauntletContractViolation,
    );
    expect(() => finalizeGameGauntletRound(validInput({ rollbackReference: "" }))).toThrow(
      GameGauntletContractViolation,
    );
  });
});
