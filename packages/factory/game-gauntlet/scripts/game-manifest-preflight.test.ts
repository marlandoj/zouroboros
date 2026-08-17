import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AXIOM_VEIL_CONTROLS_MUTATED_BUNDLE,
  AXIOM_VEIL_SOURCE_MUTATED_BUNDLE,
  AXIOM_VEIL_VALID_ROUND,
} from "./game-manifest-contract";
import {
  gameManifestGateMode,
  gameManifestPreflightSummary,
  runGameManifestPreflight,
} from "./game-manifest-preflight";

const testRoot = join(import.meta.dir, ".game-manifest-preflight-test");

afterEach(() => rmSync(testRoot, { force: true, recursive: true }));

function roundFile(name: string, value: unknown): string {
  mkdirSync(testRoot, { recursive: true });
  const path = join(testRoot, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("game manifest gate configuration", () => {
  test("is disabled by default", () => {
    expect(gameManifestGateMode({})).toBe("off");
    expect(runGameManifestPreflight({})).toEqual({
      mode: "off",
      allowed: true,
      roundPath: null,
      decision: null,
      reason: "disabled",
    });
  });

  test("fails closed on invalid configuration or an unusable round file", () => {
    expect(() => gameManifestGateMode({ FACTORY_GAME_MANIFEST_GATE: "maybe" })).toThrow();
    expect(runGameManifestPreflight({ FACTORY_GAME_MANIFEST_GATE: "1" })).toMatchObject({
      mode: "enforce",
      allowed: false,
      reason: "missing-round-path",
    });
    expect(
      runGameManifestPreflight({
        FACTORY_GAME_MANIFEST_GATE: "1",
        FACTORY_GAME_MANIFEST_ROUND_PATH: "relative.json",
      }),
    ).toMatchObject({ allowed: false, reason: "round-path-not-absolute" });
    expect(
      runGameManifestPreflight({
        FACTORY_GAME_MANIFEST_GATE: "enforce",
        FACTORY_GAME_MANIFEST_ROUND_PATH: join(testRoot, "absent.json"),
      }),
    ).toMatchObject({ allowed: false, reason: "round-path-not-found" });
    expect(
      runGameManifestPreflight({
        FACTORY_GAME_MANIFEST_GATE: "enforce",
        FACTORY_GAME_MANIFEST_ROUND_PATH: roundFile("partial.json", { ...AXIOM_VEIL_VALID_ROUND, lease: null }),
      }),
    ).toMatchObject({ allowed: false, reason: "round-missing-lease" });
  });
});

describe("game manifest pre-dispatch enforcement", () => {
  test("admits a round whose governed hashes survived capture", () => {
    const result = runGameManifestPreflight({
      FACTORY_GAME_MANIFEST_GATE: "enforce",
      FACTORY_GAME_MANIFEST_ROUND_PATH: roundFile("valid.json", AXIOM_VEIL_VALID_ROUND),
    });
    expect(result.decision?.report.violations).toEqual([]);
    expect(result.reason).toBe("valid");
    expect(result.allowed).toBe(true);
    expect(result.decision?.terminalState).toBeNull();
    expect(gameManifestPreflightSummary(result)).toContain("scores=eligible");
  });

  test.each([
    ["source", AXIOM_VEIL_SOURCE_MUTATED_BUNDLE],
    ["controls", AXIOM_VEIL_CONTROLS_MUTATED_BUNDLE],
  ])("blocks a round whose %s was mutated under the lease", (label, after) => {
    const result = runGameManifestPreflight({
      FACTORY_GAME_MANIFEST_GATE: "1",
      FACTORY_GAME_MANIFEST_ROUND_PATH: roundFile(`${label}.json`, { ...AXIOM_VEIL_VALID_ROUND, after }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("invalid-evidence");
    expect(result.decision?.terminalState).toBe("INVALID_EVIDENCE");
    expect(result.decision?.scoresSuppressed).toBe(true);
    expect(result.decision?.promotionBlocked).toBe(true);
    const summary = gameManifestPreflightSummary(result);
    expect(summary).toContain("state=INVALID_EVIDENCE");
    expect(summary).toContain("scores=suppressed");
    expect(summary).toContain("promotion=blocked");
    expect(summary).toContain("rollback=git:refs/tags/axiom-veil-slice-0003");
  });

  test("blocks a round that lost its incumbent or rollback reference", () => {
    const result = runGameManifestPreflight({
      FACTORY_GAME_MANIFEST_GATE: "1",
      FACTORY_GAME_MANIFEST_ROUND_PATH: roundFile("no-rollback.json", {
        ...AXIOM_VEIL_VALID_ROUND,
        incumbentHash: "",
        rollbackReference: "",
      }),
    });
    expect(result.allowed).toBe(false);
    expect(result.decision?.terminalState).toBe("INVALID_EVIDENCE");
    expect(result.decision?.report.violations.map((violation) => violation.code)).toEqual([
      "missing-incumbent",
      "missing-rollback-reference",
    ]);
  });

  test("blocks an expired lease using the round timestamp", () => {
    const result = runGameManifestPreflight({
      FACTORY_GAME_MANIFEST_GATE: "1",
      FACTORY_GAME_MANIFEST_ROUND_PATH: roundFile("expired.json", {
        ...AXIOM_VEIL_VALID_ROUND,
        now: "2026-08-14T00:00:00.000Z",
      }),
    });
    expect(result.allowed).toBe(false);
    expect(result.decision?.report.violations.map((violation) => violation.code)).toEqual(["lease-expired"]);
  });
});
