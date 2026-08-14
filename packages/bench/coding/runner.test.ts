import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NoopCodingRunner,
  ReferenceCodingRunner,
  loadCodingManifest,
  resolveProcessCommand,
  runCodingTask,
  type AgentRunContext,
  type AgentRunResult,
  type CodingAgentRunner,
} from "./runner";

const packageRoot = resolve(import.meta.dir, "..");

describe("ZouroBench Code runner", () => {
  test("runs TypeScript through Bun instead of the Node-dependent pnpm wrapper", () => {
    const resolved = resolveProcessCommand(["tsc", "--noEmit", "-p", "tsconfig.json"]);
    expect(resolved[0]).toBe(process.execPath);
    expect(resolved[1]).toEndWith("/node_modules/typescript/bin/tsc");
    expect(resolved.slice(2)).toEqual(["--noEmit", "-p", "tsconfig.json"]);
  });

  test("preserves Ubuntu resolver access inside Bubblewrap", () => {
    const wrapper = readFileSync(resolve(import.meta.dir, "bwrap-acp.sh"), "utf8");
    expect(wrapper).toContain("if [[ -d /run/systemd/resolve ]]");
    expect(wrapper).toContain("--dir /run");
    expect(wrapper).toContain("--dir /run/systemd");
    expect(wrapper).toContain("--ro-bind /run/systemd/resolve /run/systemd/resolve");
  });

  test("keeps hidden checks unavailable until the executor returns", async () => {
    const task = loadCodingManifest().tasks[0]!;
    let capturedWorkdir = "";
    const runner: CodingAgentRunner = {
      executor: "fixture-visibility",
      model: "fixture:visibility",
      sandbox: "fixture",
      async run(context: AgentRunContext): Promise<AgentRunResult> {
        capturedWorkdir = context.workdir;
        expect(existsSync(resolve(context.workdir, ".zbc-hidden"))).toBeFalse();
        cpSync(resolve(packageRoot, context.task.solutionDir), context.workdir, { recursive: true, force: true });
        return { success: true, output: "solution applied", durationMs: 1 };
      },
    };
    const result = await runCodingTask(task, runner);
    expect(result.status).toBe("pass");
    expect(existsSync(capturedWorkdir)).toBeFalse();
  }, 30_000);

  test("separates the reference solution from an untouched starter", async () => {
    const task = loadCodingManifest().tasks[0]!;
    const reference = await runCodingTask(task, new ReferenceCodingRunner());
    const noop = await runCodingTask(task, new NoopCodingRunner());
    expect(reference.status).toBe("pass");
    expect(reference.scores.overall).toBe(100);
    expect(noop.status).toBe("fail");
    expect(noop.scores.overall).toBeLessThan(reference.scores.overall);
  }, 30_000);

  test("assigns zero points when the production executor fails", async () => {
    const task = loadCodingManifest().tasks[0]!;
    const failed: CodingAgentRunner = {
      executor: "fixture-error",
      model: "fixture:error",
      sandbox: "fixture",
      async run() {
        return { success: false, output: "", durationMs: 1, error: "transport unavailable" };
      },
    };
    const result = await runCodingTask(task, failed);
    expect(result.status).toBe("executor-error");
    expect(result.scores.overall).toBe(0);
  }, 30_000);
});
