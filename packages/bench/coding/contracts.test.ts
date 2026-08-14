import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODE_BENCHMARK_FOLDS,
  manifestFingerprint,
  validateCodingManifest,
  type CodingCorpusManifest,
} from "./contracts";

const manifestPath = resolve(import.meta.dir, "..", "data", "zourobench-code", "manifest.json");

function manifest(): CodingCorpusManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CodingCorpusManifest;
}

describe("ZouroBench Code manifest", () => {
  test("freezes a balanced twenty-task, five-fold corpus", () => {
    const value = manifest();
    expect(validateCodingManifest(value)).toEqual([]);
    expect(value.tasks).toHaveLength(20);
    for (const fold of CODE_BENCHMARK_FOLDS) {
      expect(value.tasks.filter((task) => task.fold === fold)).toHaveLength(4);
    }
    expect(manifestFingerprint(value)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects duplicate task identities and incomplete folds", () => {
    const value = structuredClone(manifest());
    value.tasks[1]!.id = value.tasks[0]!.id;
    value.tasks.pop();
    const errors = validateCodingManifest(value);
    expect(errors.some((error) => error.includes("duplicate task id"))).toBeTrue();
    expect(errors.some((error) => error.includes("exactly 20 tasks"))).toBeTrue();
    expect(errors.some((error) => error.includes("expected four tasks"))).toBeTrue();
  });
});
