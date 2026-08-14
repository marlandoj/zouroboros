import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { selectFinalStepEntries } from "../scripts/procedural-recall";

const seed = JSON.parse(readFileSync("/home/workspace/zouroboros/packages/bench/data/zourobench/seed.json", "utf8")) as {
  procedures: Array<{
    name: string;
    versions: Array<{
      version: number;
      steps: Array<{ executor: string; taskPattern: string }>;
    }>;
  }>;
};

test("returns every Hermes-final procedure version, including backtest v2", () => {
    const procedures = seed.procedures.flatMap((procedure) =>
      procedure.versions.map((version) => ({
        name: procedure.name,
        version: version.version,
        steps: version.steps,
      })),
    );

    const matches = selectFinalStepEntries(procedures, "hermes");
    expect(matches.map((entry) => entry.split(": FINAL step")[0])).toEqual([
      "deploy-production v1",
      "deploy-production v2",
      "incident-response v1",
      "backtest-optimization v2",
    ]);
});

test("does not treat an intermediate Hermes step as a final-step match", () => {
    const procedures = seed.procedures.flatMap((procedure) =>
      procedure.versions.map((version) => ({
        name: procedure.name,
        version: version.version,
        steps: version.steps,
      })),
    );

    const matches = selectFinalStepEntries(procedures, "hermes");
    expect(matches.some((entry) => entry.includes("security-audit-scan"))).toBe(false);
    expect(matches.some((entry) => entry.includes("blog-publish-pipeline"))).toBe(false);
});
