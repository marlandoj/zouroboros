import { describe, expect, test } from "bun:test";
import { runExecutorChain, type ExecutorLifecycleEvent } from "./executor-runner";
import { classifyHarnessFailureDetail, type HarnessRunResult } from "./harness-router";

function result(executorId: string, success: boolean, output = "ok"): HarnessRunResult {
  return { executorId, success, output, durationMs: 1000 };
}

describe("executor runner", () => {
  test("classifies transport evidence without treating arbitrary 5xx prose as transport", () => {
    expect(classifyHarnessFailureDetail("API error: 503 Service Unavailable")).toBe("transport");
    expect(classifyHarnessFailureDetail("ACP session timed out after 30000ms")).toBe("transport");
    expect(classifyHarnessFailureDetail("unit test expected status 500 but got 200")).toBe("execution");
  });

  test("emits the complete lifecycle in contract order", async () => {
    const events: ExecutorLifecycleEvent[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      idleTimeoutMs: 250,
      env: { ZO_TRACE_ID: "factory:exec-test" },
      chain: ["claude-code"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (_id, _prompt, options) => {
        if (!options) throw new Error("executor options missing");
        expect(options.env).toEqual({ ZO_TRACE_ID: "factory:exec-test" });
        expect(options.idleTimeoutMs).toBe(250);
        options.onOutput?.("chunk");
        return {
          ...result("claude-code", true),
          modelUsed: "synthetic-new/hf:zai-org/GLM-5.2",
          tokensUsed: 30,
          inputTokens: 20,
          outputTokens: 10,
          costUsd: 0.004,
        };
      },
      onEvent: (event) => events.push(event),
    });

    expect(run.success).toBe(true);
    expect(run.modelUsed).toBe("synthetic-new/hf:zai-org/GLM-5.2");
    expect(run.tokensUsed).toBe(30);
    expect(run.inputTokens).toBe(20);
    expect(run.outputTokens).toBe(10);
    expect(run.costUsd).toBe(0.004);
    expect(events.map((event) => event.kind)).toEqual([
      "exec.start",
      "probe.ok",
      "executor.start",
      "executor.ok",
      "exec.implementation_complete",
    ]);
  });

  test("propagates the idle budget to every failover rung", async () => {
    const idleBudgets: Array<number | undefined> = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      idleTimeoutMs: 80,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id, _prompt, options) => {
        idleBudgets.push(options?.idleTimeoutMs);
        return result(id, id === "codex");
      },
    });

    expect(run.executorId).toBe("codex");
    expect(idleBudgets).toEqual([80, 80]);
  });

  test("fails over without dispatching an unhealthy executor", async () => {
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async (id) => ({ healthy: id === "codex", message: id }),
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, true);
      },
    });

    expect(run.executorId).toBe("codex");
    expect(calls).toEqual(["codex"]);
  });

  test("fails over after an executor returns an unsuccessful result", async () => {
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, id === "codex", id === "codex" ? "ok" : "failed");
      },
    });

    expect(run.success).toBe(true);
    expect(run.executorId).toBe("codex");
    expect(calls).toEqual(["claude-code", "codex"]);
    expect(run.trail[0]).toContain("claude-code=fail");
  });

  test("never infers transport from failed agent output", async () => {
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async () => result("codex", false, "API error: 503 Service Unavailable"),
    });

    expect(run.trail[0]).toContain("codex=fail(1s):execution:API error: 503 Service Unavailable");
  });

  test("fails over after an executor throws", async () => {
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id) => {
        if (id === "claude-code") throw new Error("socket hang up: ECONNRESET");
        return result(id, true);
      },
    });

    expect(run.executorId).toBe("codex");
    expect(run.trail[0]).toContain("claude-code=throw:transport:socket hang up: ECONNRESET");
  });

  test("treats a throwing health probe as unhealthy and continues", async () => {
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async (id) => {
        if (id === "claude-code") throw new Error("probe unavailable");
        return { healthy: true, message: "ok" };
      },
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, true);
      },
    });

    expect(run.executorId).toBe("codex");
    expect(calls).toEqual(["codex"]);
    expect(run.trail[0]).toBe("executor:claude-code=unhealthy");
  });

  test("records a terminal failure after the chain is exhausted", async () => {
    const events: ExecutorLifecycleEvent[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: false, message: "down" }),
      harnessRun: async (id) => result(id, true),
      onEvent: (event) => events.push(event),
    });

    expect(run.success).toBe(false);
    expect(run.error).toContain("chain exhausted");
    expect(events.at(-1)?.kind).toBe("exec.failed");
    expect(run.trail).toEqual([
      "executor:claude-code=unhealthy",
      "executor:codex=unhealthy",
    ]);
  });
});
