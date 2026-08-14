import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { assertSafeGitState, parseProgram } from "./autoloop";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "autoloop-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("parseProgram", () => {
  test("parses documented duration and cost units", () => {
    const directory = temporaryDirectory();
    const program = join(directory, "program.md");
    writeFileSync(program, `# Program: skill-refinement

## Objective
Improve a skill.

## Metric
- **name**: quality
- **direction**: higher_is_better
- **extract**: echo 1

## Target File
SKILL.md

## Run Command
echo ok

## Constraints
- **Time budget per run**: 5 minutes
- **Max experiments**: 7
- **Max duration**: 2 hours
- **Max cost (USD)**: 1.25
`);

    const config = parseProgram(program);
    expect(config.constraints.timeBudgetSeconds).toBe(300);
    expect(config.constraints.maxExperiments).toBe(7);
    expect(config.constraints.maxDurationHours).toBe(2);
    expect(config.constraints.maxCostUSD).toBe(1.25);
  });
});

describe("assertSafeGitState", () => {
  test("accepts a clean repository with a tracked target", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "SKILL.md"), "initial\n");
    await $`git init -q`.cwd(directory);
    await $`git config user.email autoloop@example.test`.cwd(directory);
    await $`git config user.name Autoloop Test`.cwd(directory);
    await $`git add SKILL.md`.cwd(directory);
    await $`git commit -qm initial`.cwd(directory);

    expect(await assertSafeGitState(directory, "SKILL.md")).toBe(directory);
  });

  test("rejects dirty tracked files", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "SKILL.md"), "initial\n");
    await $`git init -q`.cwd(directory);
    await $`git config user.email autoloop@example.test`.cwd(directory);
    await $`git config user.name Autoloop Test`.cwd(directory);
    await $`git add SKILL.md`.cwd(directory);
    await $`git commit -qm initial`.cwd(directory);
    writeFileSync(join(directory, "SKILL.md"), "changed\n");

    await expect(assertSafeGitState(directory, "SKILL.md")).rejects.toThrow("Tracked worktree is not clean");
  });
});
