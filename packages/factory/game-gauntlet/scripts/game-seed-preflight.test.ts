import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AXIOM_VEIL_40X_MISMATCH_FIXTURE,
  AXIOM_VEIL_ADAPTED_FIXTURE,
} from "./game-seed-contract";
import { gameSeedGateMode, runGameSeedPreflight } from "./game-seed-preflight";

const testRoot = join(import.meta.dir, ".game-seed-preflight-test");

afterEach(() => rmSync(testRoot, { force: true, recursive: true }));

function contractFile(name: string, value: unknown): string {
  mkdirSync(testRoot, { recursive: true });
  const path = join(testRoot, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("game seed gate configuration", () => {
  test("is disabled by default", () => {
    expect(gameSeedGateMode({})).toBe("off");
    expect(runGameSeedPreflight({})).toEqual({
      mode: "off",
      allowed: true,
      contractPath: null,
      decisions: [],
      reason: "disabled",
    });
  });

  test("fails closed on invalid configuration or a missing contract path", () => {
    expect(() => gameSeedGateMode({ FACTORY_GAME_SEED_GATE: "maybe" })).toThrow();
    expect(runGameSeedPreflight({ FACTORY_GAME_SEED_GATE: "1" })).toMatchObject({
      mode: "enforce",
      allowed: false,
      reason: "missing-contract-path",
    });
    expect(runGameSeedPreflight({
      FACTORY_GAME_SEED_GATE: "1",
      FACTORY_GAME_SEED_CONTRACT_PATH: "relative.json",
    })).toMatchObject({ allowed: false, reason: "contract-path-not-absolute" });
  });
});

describe("game seed pre-dispatch enforcement", () => {
  test("blocks the frozen 40x mismatch at both dispatch stages", () => {
    const result = runGameSeedPreflight({
      FACTORY_GAME_SEED_GATE: "1",
      FACTORY_GAME_SEED_CONTRACT_PATH: contractFile("invalid.json", AXIOM_VEIL_40X_MISMATCH_FIXTURE),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("contract-invalid");
    expect(result.decisions.map((decision) => [decision.stage, decision.allowed])).toEqual([
      ["parallel-implementation", false],
      ["critic-dispatch", false],
    ]);
  });

  test("allows a contract whose 40x conversion uses a declared adapter", () => {
    const result = runGameSeedPreflight({
      FACTORY_GAME_SEED_GATE: "enforce",
      FACTORY_GAME_SEED_CONTRACT_PATH: contractFile("valid.json", AXIOM_VEIL_ADAPTED_FIXTURE),
    });
    expect(result.decisions.flatMap((decision) => decision.report.violations.map((violation) => violation.code))).toEqual([]);
    expect(result.reason).toBe("valid");
    expect(result.allowed).toBe(true);
    expect(result.decisions.every((decision) => decision.allowed)).toBe(true);
  });
});
