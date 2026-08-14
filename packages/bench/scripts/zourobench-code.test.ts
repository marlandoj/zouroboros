import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadCodingManifest } from "../coding/runner";

test("preflight runs one task without writing cohort evidence", () => {
  const task = loadCodingManifest().tasks[0]!;
  const script = resolve(import.meta.dir, "zourobench-code.ts");
  const result = Bun.spawnSync([
    "bun",
    script,
    "preflight",
    "--executor",
    "reference",
    "--task",
    task.id,
  ]);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()) as {
    task: string;
    status: string;
    executorSuccess: boolean;
    patchFiles: string[];
    cohortEvidenceWritten: boolean;
  };
  expect(output.task).toBe(task.id);
  expect(output.status).toBe("pass");
  expect(output.executorSuccess).toBeTrue();
  expect(output.patchFiles.length).toBeGreaterThan(0);
  expect(output.cohortEvidenceWritten).toBeFalse();
});
