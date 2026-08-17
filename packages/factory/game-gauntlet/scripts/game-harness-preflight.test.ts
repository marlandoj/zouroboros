import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AXIOM_VEIL_CERTIFIED_HARNESS,
  AXIOM_VEIL_FROZEN_TITLE_FIXTURE,
  AXIOM_VEIL_STALE_CONTROLS_FIXTURE,
} from "./game-harness-certification";
import {
  gameHarnessGateMode,
  gameHarnessPreflightSummary,
  runGameHarnessPreflight,
} from "./game-harness-preflight";

const testRoot = join(import.meta.dir, ".game-harness-preflight-test");

afterEach(() => rmSync(testRoot, { force: true, recursive: true }));

function certificationFile(name: string, value: unknown): string {
  mkdirSync(testRoot, { recursive: true });
  const path = join(testRoot, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("game harness gate configuration", () => {
  test("is disabled by default", () => {
    expect(gameHarnessGateMode({})).toBe("off");
    expect(runGameHarnessPreflight({})).toEqual({
      mode: "off",
      allowed: true,
      certificationPath: null,
      decision: null,
      reason: "disabled",
    });
    expect(gameHarnessGateMode({ FACTORY_GAME_HARNESS_GATE: "off" })).toBe("off");
    expect(gameHarnessGateMode({ FACTORY_GAME_HARNESS_GATE: "enforce" })).toBe("enforce");
  });

  test("fails closed on invalid configuration or an unusable certification file", () => {
    expect(() => gameHarnessGateMode({ FACTORY_GAME_HARNESS_GATE: "maybe" })).toThrow();
    expect(runGameHarnessPreflight({ FACTORY_GAME_HARNESS_GATE: "1" })).toMatchObject({
      mode: "enforce",
      allowed: false,
      reason: "missing-certification-path",
    });
    expect(
      runGameHarnessPreflight({
        FACTORY_GAME_HARNESS_GATE: "1",
        FACTORY_GAME_HARNESS_CERTIFICATION_PATH: "relative.json",
      }),
    ).toMatchObject({ allowed: false, reason: "certification-path-not-absolute" });
    expect(
      runGameHarnessPreflight({
        FACTORY_GAME_HARNESS_GATE: "enforce",
        FACTORY_GAME_HARNESS_CERTIFICATION_PATH: join(testRoot, "absent.json"),
      }),
    ).toMatchObject({ allowed: false, reason: "certification-path-not-found" });

    mkdirSync(testRoot, { recursive: true });
    const listPath = join(testRoot, "list.json");
    writeFileSync(listPath, "[]\n");
    expect(
      runGameHarnessPreflight({
        FACTORY_GAME_HARNESS_GATE: "1",
        FACTORY_GAME_HARNESS_CERTIFICATION_PATH: listPath,
      }),
    ).toMatchObject({ allowed: false, reason: "certification-not-a-mapping" });

    const brokenPath = join(testRoot, "broken.json");
    writeFileSync(brokenPath, "{ not json\n\tand: not yaml\n");
    expect(
      runGameHarnessPreflight({
        FACTORY_GAME_HARNESS_GATE: "1",
        FACTORY_GAME_HARNESS_CERTIFICATION_PATH: brokenPath,
      }),
    ).toMatchObject({ allowed: false });
  });

  test("fails closed when a required certification section is absent", () => {
    for (const key of [
      "productionInputMap",
      "productionControlsManifest",
      "runtimeIdentity",
      "observation",
      "bindings",
    ] as const) {
      const { [key]: _omitted, ...rest } = AXIOM_VEIL_CERTIFIED_HARNESS;
      const path = certificationFile(`missing-${key}.json`, rest);
      expect(
        runGameHarnessPreflight({
          FACTORY_GAME_HARNESS_GATE: "1",
          FACTORY_GAME_HARNESS_CERTIFICATION_PATH: path,
        }),
      ).toMatchObject({ allowed: false, reason: `certification-missing-${key}` });
    }
  });
});

describe("game harness preflight decisions", () => {
  test("certifies a serialized production-derived certification", () => {
    const path = certificationFile("certified.json", AXIOM_VEIL_CERTIFIED_HARNESS);
    const result = runGameHarnessPreflight({
      FACTORY_GAME_HARNESS_GATE: "1",
      FACTORY_GAME_HARNESS_CERTIFICATION_PATH: path,
    });
    expect(result).toMatchObject({ mode: "enforce", allowed: true, reason: "certified" });
    expect(result.decision?.verdict).toBe("CERTIFIED");
    const summary = gameHarnessPreflightSummary(result);
    expect(summary).toContain("verdict=CERTIFIED");
    expect(summary).toContain("failed=none");
    expect(summary).toContain("viewport=1920x1080@2");
    expect(summary).toContain("driver=SwiftShader 5.0.0");
  });

  test("blocks a frozen title and reports every failing check", () => {
    const path = certificationFile("frozen-title.json", AXIOM_VEIL_FROZEN_TITLE_FIXTURE);
    const result = runGameHarnessPreflight({
      FACTORY_GAME_HARNESS_GATE: "enforce",
      FACTORY_GAME_HARNESS_CERTIFICATION_PATH: path,
    });
    expect(result).toMatchObject({ allowed: false, reason: "harness-not-certified" });
    expect(result.decision?.verdict).toBe("HARNESS_NOT_CERTIFIED");
    expect(result.decision?.terminalState).toBe("BLOCKED");
    expect(result.decision?.scoresSuppressed).toBe(true);
    const summary = gameHarnessPreflightSummary(result);
    expect(summary).toContain("blocked");
    expect(summary).toContain("title-dismissal");
    expect(summary).toContain("clock-advance");
  });

  test("blocks a stale critic-brief control binding read from disk", () => {
    const path = certificationFile("stale-controls.json", AXIOM_VEIL_STALE_CONTROLS_FIXTURE);
    const result = runGameHarnessPreflight({
      FACTORY_GAME_HARNESS_GATE: "1",
      FACTORY_GAME_HARNESS_CERTIFICATION_PATH: path,
    });
    expect(result.allowed).toBe(false);
    expect(result.decision?.violations.map((violation) => violation.code)).toContain("stale-binding");
    expect(gameHarnessPreflightSummary(result)).toContain("failed=production-input-map");
  });
});
