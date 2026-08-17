import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  gateEveryGameSeedStage,
  type GameSeedGateDecision,
  type GameSeedDimensionalContract,
} from "./game-seed-contract";

export type GameSeedGateMode = "off" | "enforce";

export interface GameSeedPreflightResult {
  mode: GameSeedGateMode;
  allowed: boolean;
  contractPath: string | null;
  decisions: readonly GameSeedGateDecision[];
  reason: string;
}

export function gameSeedGateMode(
  env: Record<string, string | undefined> = process.env,
): GameSeedGateMode {
  const raw = env.FACTORY_GAME_SEED_GATE?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off") return "off";
  if (raw === "1" || raw === "enforce") return "enforce";
  throw new Error(`Invalid FACTORY_GAME_SEED_GATE value: ${raw}`);
}

export function runGameSeedPreflight(
  env: Record<string, string | undefined> = process.env,
): GameSeedPreflightResult {
  const mode = gameSeedGateMode(env);
  if (mode === "off") {
    return { mode, allowed: true, contractPath: null, decisions: [], reason: "disabled" };
  }

  const contractPath = env.FACTORY_GAME_SEED_CONTRACT_PATH?.trim() ?? "";
  if (!contractPath) {
    return { mode, allowed: false, contractPath: null, decisions: [], reason: "missing-contract-path" };
  }
  if (!isAbsolute(contractPath)) {
    return { mode, allowed: false, contractPath, decisions: [], reason: "contract-path-not-absolute" };
  }
  if (!existsSync(contractPath)) {
    return { mode, allowed: false, contractPath, decisions: [], reason: "contract-path-not-found" };
  }

  try {
    const contents = readFileSync(contractPath, "utf8");
    const parsed = contents.trimStart().startsWith("{") ? JSON.parse(contents) : Bun.YAML.parse(contents);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { mode, allowed: false, contractPath, decisions: [], reason: "contract-not-a-mapping" };
    }
    const decisions = gateEveryGameSeedStage(parsed as GameSeedDimensionalContract);
    const allowed = decisions.length > 0 && decisions.every((decision) => decision.allowed);
    return {
      mode,
      allowed,
      contractPath,
      decisions,
      reason: allowed ? "valid" : "contract-invalid",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { mode, allowed: false, contractPath, decisions: [], reason: `contract-unreadable:${detail}` };
  }
}

export function gameSeedPreflightSummary(result: GameSeedPreflightResult): string {
  const stages = result.decisions.map((decision) => `${decision.stage}:${decision.allowed ? "pass" : "blocked"}`);
  return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}` +
    (stages.length ? ` stages=${stages.join(",")}` : "");
}
