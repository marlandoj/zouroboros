import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  certifyHarness,
  type HarnessCertificationDecision,
  type HarnessCertificationInput,
} from "./game-harness-certification";

export type GameHarnessGateMode = "off" | "enforce";

export interface GameHarnessPreflightResult {
  mode: GameHarnessGateMode;
  allowed: boolean;
  certificationPath: string | null;
  decision: HarnessCertificationDecision | null;
  reason: string;
}

export function gameHarnessGateMode(
  env: Record<string, string | undefined> = process.env,
): GameHarnessGateMode {
  const raw = env.FACTORY_GAME_HARNESS_GATE?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off") return "off";
  if (raw === "1" || raw === "enforce") return "enforce";
  throw new Error(`Invalid FACTORY_GAME_HARNESS_GATE value: ${raw}`);
}

function blocked(
  mode: GameHarnessGateMode,
  certificationPath: string | null,
  reason: string,
): GameHarnessPreflightResult {
  return { mode, allowed: false, certificationPath, decision: null, reason };
}

export function runGameHarnessPreflight(
  env: Record<string, string | undefined> = process.env,
): GameHarnessPreflightResult {
  const mode = gameHarnessGateMode(env);
  if (mode === "off") {
    return { mode, allowed: true, certificationPath: null, decision: null, reason: "disabled" };
  }

  const certificationPath = env.FACTORY_GAME_HARNESS_CERTIFICATION_PATH?.trim() ?? "";
  if (!certificationPath) return blocked(mode, null, "missing-certification-path");
  if (!isAbsolute(certificationPath)) return blocked(mode, certificationPath, "certification-path-not-absolute");
  if (!existsSync(certificationPath)) return blocked(mode, certificationPath, "certification-path-not-found");

  let parsed: unknown;
  try {
    const contents = readFileSync(certificationPath, "utf8");
    parsed = contents.trimStart().startsWith("{") ? JSON.parse(contents) : Bun.YAML.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return blocked(mode, certificationPath, `certification-unreadable:${detail}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return blocked(mode, certificationPath, "certification-not-a-mapping");
  }

  const certification = parsed as Partial<HarnessCertificationInput>;
  for (const key of ["productionInputMap", "productionControlsManifest", "runtimeIdentity", "observation"] as const) {
    const value = certification[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return blocked(mode, certificationPath, `certification-missing-${key}`);
    }
  }
  if (!Array.isArray(certification.bindings)) {
    return blocked(mode, certificationPath, "certification-missing-bindings");
  }

  const decision = certifyHarness(certification as HarnessCertificationInput);
  return {
    mode,
    allowed: decision.criticDispatchAllowed,
    certificationPath,
    decision,
    reason: decision.certified ? "certified" : "harness-not-certified",
  };
}

export function gameHarnessPreflightSummary(result: GameHarnessPreflightResult): string {
  const decision = result.decision;
  if (!decision) return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}`;
  const failed = Object.entries(decision.checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check);
  const identity = decision.runtimeIdentity;
  const runtime = identity
    ? ` viewport=${identity.viewportWidth}x${identity.viewportHeight}@${identity.devicePixelRatio}` +
      ` renderer=${identity.renderer || "unknown"} driver=${identity.driver || "unknown"} build=${identity.buildId || "unknown"}`
    : "";
  return (
    `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}` +
    ` verdict=${decision.verdict} state=${decision.terminalState ?? "none"}` +
    ` scores=${decision.scoresSuppressed ? "suppressed" : "eligible"}` +
    ` failed=${failed.length ? failed.join(",") : "none"}${runtime}`
  );
}
