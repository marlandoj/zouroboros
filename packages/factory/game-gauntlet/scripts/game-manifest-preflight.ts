import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  gateCriticRound,
  type CriticRoundDecision,
  type CriticRoundInput,
} from "./game-manifest-contract";

export type GameManifestGateMode = "off" | "enforce";

export interface GameManifestPreflightResult {
  mode: GameManifestGateMode;
  allowed: boolean;
  roundPath: string | null;
  decision: CriticRoundDecision | null;
  reason: string;
}

export function gameManifestGateMode(
  env: Record<string, string | undefined> = process.env,
): GameManifestGateMode {
  const raw = env.FACTORY_GAME_MANIFEST_GATE?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off") return "off";
  if (raw === "1" || raw === "enforce") return "enforce";
  throw new Error(`Invalid FACTORY_GAME_MANIFEST_GATE value: ${raw}`);
}

function blocked(
  mode: GameManifestGateMode,
  roundPath: string | null,
  reason: string,
): GameManifestPreflightResult {
  return { mode, allowed: false, roundPath, decision: null, reason };
}

export function runGameManifestPreflight(
  env: Record<string, string | undefined> = process.env,
): GameManifestPreflightResult {
  const mode = gameManifestGateMode(env);
  if (mode === "off") {
    return { mode, allowed: true, roundPath: null, decision: null, reason: "disabled" };
  }

  const roundPath = env.FACTORY_GAME_MANIFEST_ROUND_PATH?.trim() ?? "";
  if (!roundPath) return blocked(mode, null, "missing-round-path");
  if (!isAbsolute(roundPath)) return blocked(mode, roundPath, "round-path-not-absolute");
  if (!existsSync(roundPath)) return blocked(mode, roundPath, "round-path-not-found");

  let parsed: unknown;
  try {
    const contents = readFileSync(roundPath, "utf8");
    parsed = contents.trimStart().startsWith("{") ? JSON.parse(contents) : Bun.YAML.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return blocked(mode, roundPath, `round-unreadable:${detail}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return blocked(mode, roundPath, "round-not-a-mapping");
  }

  const round = parsed as Partial<CriticRoundInput>;
  for (const key of ["before", "after", "lease"] as const) {
    const value = round[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return blocked(mode, roundPath, `round-missing-${key}`);
    }
  }

  const decision = gateCriticRound({
    before: round.before as CriticRoundInput["before"],
    after: round.after as CriticRoundInput["after"],
    lease: round.lease as CriticRoundInput["lease"],
    now: typeof round.now === "string" && round.now.trim() ? round.now : new Date().toISOString(),
    incumbentHash: typeof round.incumbentHash === "string" ? round.incumbentHash : "",
    rollbackReference: typeof round.rollbackReference === "string" ? round.rollbackReference : "",
  });

  return {
    mode,
    allowed: decision.allowed,
    roundPath,
    decision,
    reason: decision.allowed ? "valid" : "invalid-evidence",
  };
}

export function gameManifestPreflightSummary(result: GameManifestPreflightResult): string {
  const decision = result.decision;
  const detail = decision
    ? ` state=${decision.terminalState ?? "none"} scores=${decision.scoresSuppressed ? "suppressed" : "eligible"}` +
      ` promotion=${decision.promotionBlocked ? "blocked" : "eligible"} mutations=${decision.report.mutations.length}` +
      ` rollback=${decision.rollbackReference || "none"}`
    : "";
  return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}${detail}`;
}
