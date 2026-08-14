import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface SwarmArtifacts {
  basePath: string;
  completionPath: string | null;
  swarmId: string;
  baseExists: boolean;
  completionExists: boolean;
  terminal: boolean;
}

const TERMINAL_STATUSES = new Set([
  "complete",
  "completed",
  "completed_with_failures",
  "failed",
  "failure",
  "success",
]);

function homeDir(): string {
  return process.env.HOME || homedir() || "/root";
}

export function swarmResultsDir(): string {
  return process.env.SWARM_RESULTS_DIR || join(homeDir(), ".swarm", "results");
}

function expandHome(input: string): string {
  return input.startsWith("~/") ? join(homeDir(), input.slice(2)) : input;
}

function isPathInput(input: string): boolean {
  return isAbsolute(input) || input.includes("/") || input.includes("\\") || input.endsWith(".json");
}

function pathsForInput(raw: string): { basePath: string; siblingCompletionPath: string; swarmId: string } | null {
  const input = expandHome(raw.trim());
  if (!input) return null;

  if (!isPathInput(input)) {
    return {
      basePath: join(swarmResultsDir(), `${input}.json`),
      siblingCompletionPath: join(swarmResultsDir(), `${input}-complete.json`),
      swarmId: input,
    };
  }

  const absoluteInput = isAbsolute(input) ? input : resolve(input);
  const basePath = absoluteInput.endsWith("-complete.json")
    ? absoluteInput.replace(/-complete\.json$/, ".json")
    : absoluteInput.endsWith(".json")
      ? absoluteInput
      : `${absoluteInput}.json`;
  const swarmId = basename(basePath, ".json");

  return {
    basePath,
    siblingCompletionPath: join(dirname(basePath), `${swarmId}-complete.json`),
    swarmId,
  };
}

export async function resolveSwarmArtifacts(raw: string): Promise<SwarmArtifacts | null> {
  const paths = pathsForInput(raw);
  if (!paths) return null;

  const legacyCompletionPath = join(process.env.SWARM_COMPLETIONS_DIR || "/dev/shm", `${paths.swarmId}-complete.json`);
  const [baseExists, siblingExists, legacyExists] = await Promise.all([
    Bun.file(paths.basePath).exists(),
    Bun.file(paths.siblingCompletionPath).exists(),
    Bun.file(legacyCompletionPath).exists(),
  ]);

  const completionPath = siblingExists
    ? paths.siblingCompletionPath
    : legacyExists
      ? legacyCompletionPath
      : null;

  let terminal = completionPath !== null;
  if (!terminal && baseExists) {
    try {
      const base = await Bun.file(paths.basePath).json() as { status?: unknown };
      terminal = typeof base.status === "string" && TERMINAL_STATUSES.has(base.status.toLowerCase());
    } catch {
      terminal = false;
    }
  }

  return {
    basePath: paths.basePath,
    completionPath,
    swarmId: paths.swarmId,
    baseExists,
    completionExists: completionPath !== null,
    terminal,
  };
}
