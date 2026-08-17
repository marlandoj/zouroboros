export const GAME_GAUNTLET_CONTRACT_VERSION = 1 as const;

export const GAME_GAUNTLET_PHASES = ["OBSERVE", "CHOOSE", "ACT", "VERIFY", "RECORD"] as const;
export type GameGauntletPhase = (typeof GAME_GAUNTLET_PHASES)[number];

export const GAME_GAUNTLET_TERMINAL_STATES = [
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
] as const;
export type GameGauntletTerminalState = (typeof GAME_GAUNTLET_TERMINAL_STATES)[number];
export type GameGauntletState = GameGauntletPhase | GameGauntletTerminalState;

export const GAME_GAUNTLET_GAP_AUDIT_CHECKS = [
  "reachability",
  "data-prerequisites",
  "cross-boundary-state",
  "eval-production-parity",
  "dangling-identifiers",
] as const;
export type GameGauntletGapAuditCheck = (typeof GAME_GAUNTLET_GAP_AUDIT_CHECKS)[number];
export type GameGauntletGapAuditEvidence = Record<GameGauntletGapAuditCheck, boolean>;

export type ContractViolationCode = "unknown-version" | "unknown-state" | "bad-transition" | "missing-reference";

export class GameGauntletContractViolation extends Error {
  readonly code: ContractViolationCode;

  constructor(code: ContractViolationCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "GameGauntletContractViolation";
    this.code = code;
  }
}

const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(GAME_GAUNTLET_TERMINAL_STATES);
const PHASE_SET: ReadonlySet<string> = new Set(GAME_GAUNTLET_PHASES);

const ALL_TERMINALS = new Set<GameGauntletState>(GAME_GAUNTLET_TERMINAL_STATES);
const TRANSITIONS: Record<GameGauntletPhase, ReadonlySet<GameGauntletState>> = {
  OBSERVE: new Set<GameGauntletState>([
    "CHOOSE",
    "CLEAN_NOOP",
    "INVALID_EVIDENCE",
    "EXHAUSTED",
    "APPROVAL_REQUIRED",
    "BLOCKED",
    "ABORTED",
  ]),
  CHOOSE: new Set<GameGauntletState>([
    "ACT",
    "STRATEGY_REVIEW",
    "STAGNATED",
    "EXHAUSTED",
    "APPROVAL_REQUIRED",
    "BLOCKED",
    "ABORTED",
  ]),
  ACT: new Set<GameGauntletState>([
    "VERIFY",
    "INVALID_EVIDENCE",
    "REGRESSED",
    "EXHAUSTED",
    "APPROVAL_REQUIRED",
    "BLOCKED",
    "ABORTED",
  ]),
  VERIFY: new Set<GameGauntletState>([
    "RECORD",
    "INVALID_EVIDENCE",
    "REGRESSED",
    "STRATEGY_REVIEW",
    "STAGNATED",
    "EXHAUSTED",
    "APPROVAL_REQUIRED",
    "BLOCKED",
    "ABORTED",
  ]),
  RECORD: ALL_TERMINALS,
};

export function isGameGauntletPhase(value: string): value is GameGauntletPhase {
  return PHASE_SET.has(value);
}

export function isGameGauntletTerminalState(value: string): value is GameGauntletTerminalState {
  return TERMINAL_STATE_SET.has(value);
}

export function assertGameGauntletContractVersion(version: unknown): asserts version is 1 {
  if (version !== GAME_GAUNTLET_CONTRACT_VERSION) {
    throw new GameGauntletContractViolation("unknown-version", `expected 1, received ${String(version)}`);
  }
}

export function canGameGauntletTransition(from: string, to: string): boolean {
  if (isGameGauntletTerminalState(from)) return false;
  if (!isGameGauntletPhase(from)) return false;
  if (!isGameGauntletPhase(to) && !isGameGauntletTerminalState(to)) return false;
  return TRANSITIONS[from].has(to);
}

export function assertGameGauntletTransition(from: string, to: string): void {
  if (!isGameGauntletPhase(from) && !isGameGauntletTerminalState(from)) {
    throw new GameGauntletContractViolation("unknown-state", `from=${from}`);
  }
  if (!isGameGauntletPhase(to) && !isGameGauntletTerminalState(to)) {
    throw new GameGauntletContractViolation("unknown-state", `to=${to}`);
  }
  if (!canGameGauntletTransition(from, to)) {
    throw new GameGauntletContractViolation("bad-transition", `${from} -> ${to}`);
  }
}

export function isCompleteGapAuditEvidence(value: unknown): value is GameGauntletGapAuditEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === GAME_GAUNTLET_GAP_AUDIT_CHECKS.length &&
    GAME_GAUNTLET_GAP_AUDIT_CHECKS.every((check) => typeof record[check] === "boolean") &&
    keys.every((key) => (GAME_GAUNTLET_GAP_AUDIT_CHECKS as readonly string[]).includes(key))
  );
}

export function gapAuditPasses(value: unknown): value is GameGauntletGapAuditEvidence {
  return isCompleteGapAuditEvidence(value) && GAME_GAUNTLET_GAP_AUDIT_CHECKS.every((check) => value[check]);
}

export interface GameGauntletDecisionInput {
  contractVersion: unknown;
  phase: GameGauntletPhase;
  canceled: boolean;
  authorityGranted: boolean;
  approvalRequired: boolean;
  blockedReasons: readonly string[];
  limitsExhausted: boolean;
  evidenceValid: boolean;
  observationGapPresent: boolean;
  protectedGateRegressed: boolean;
  sameStrategyFailures: number;
  sameRootGapSurvivals: number;
  distinctStrategiesRemain: boolean;
  requiredLensesPass: boolean;
  postFlightPass: boolean;
  gapAudit: unknown;
  severityOneIssues: number;
  roundRecorded: boolean;
  candidateHash: string;
  incumbentHash: string;
  rollbackReference: string;
}

function hasRequiredReferences(input: GameGauntletDecisionInput): boolean {
  return [input.candidateHash, input.incumbentHash, input.rollbackReference].every((value) => value.trim().length > 0);
}

export function evaluateGameGauntletTerminalState(input: GameGauntletDecisionInput): GameGauntletTerminalState {
  assertGameGauntletContractVersion(input.contractVersion);

  if (input.canceled) return "ABORTED";
  if (!input.authorityGranted || input.approvalRequired) return "APPROVAL_REQUIRED";
  if (input.blockedReasons.length > 0) return "BLOCKED";
  if (input.limitsExhausted) return "EXHAUSTED";
  if (!input.evidenceValid || !hasRequiredReferences(input) || !isCompleteGapAuditEvidence(input.gapAudit)) {
    return "INVALID_EVIDENCE";
  }
  if (!input.observationGapPresent) return "CLEAN_NOOP";
  if (input.protectedGateRegressed) return "REGRESSED";
  if (input.sameStrategyFailures >= 2 || input.sameRootGapSurvivals >= 2) return "STRATEGY_REVIEW";
  if (!input.distinctStrategiesRemain) return "STAGNATED";

  const success =
    input.phase === "RECORD" &&
    input.roundRecorded &&
    input.requiredLensesPass &&
    input.postFlightPass &&
    gapAuditPasses(input.gapAudit) &&
    input.severityOneIssues === 0;

  return success ? "SUCCESS" : "BLOCKED";
}

export interface GameGauntletFinalization {
  terminalState: GameGauntletTerminalState;
  promoteCandidate: boolean;
  restoreIncumbent: boolean;
  incumbentHash: string;
  rollbackReference: string;
}

export function finalizeGameGauntletRound(input: GameGauntletDecisionInput): GameGauntletFinalization {
  const terminalState = evaluateGameGauntletTerminalState(input);
  const resolvedState = canGameGauntletTransition(input.phase, terminalState) ? terminalState : "BLOCKED";

  if (!input.incumbentHash.trim() || !input.rollbackReference.trim()) {
    throw new GameGauntletContractViolation(
      "missing-reference",
      "incumbentHash and rollbackReference are required before a terminal state can be recorded",
    );
  }

  const promoteCandidate = resolvedState === "SUCCESS";
  return {
    terminalState: resolvedState,
    promoteCandidate,
    restoreIncumbent: resolvedState === "REGRESSED",
    incumbentHash: promoteCandidate ? input.candidateHash : input.incumbentHash,
    rollbackReference: input.rollbackReference,
  };
}
