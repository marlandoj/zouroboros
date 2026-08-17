import {
  CODER_HARNESS_CHAIN,
  classifyHarnessFailureDetail,
  defaultHealthProbe,
  runHarness,
  type HarnessRunResult,
  type HealthProbe,
} from "./harness-router";

export type ExecutorLifecycleKind =
  | "exec.start"
  | "probe.ok"
  | "probe.unhealthy"
  | "executor.start"
  | "executor.ok"
  | "executor.fail"
  | "executor.throw"
  | "exec.implementation_complete"
  | "exec.failed";

export interface ExecutorLifecycleEvent {
  kind: ExecutorLifecycleKind;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ExecutorChainResult {
  success: boolean;
  output: string;
  executorId: string | null;
  durationMs: number;
  trail: string[];
  error: string | null;
  modelUsed?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  modelProvenance?: HarnessRunResult["modelProvenance"];
}

export interface ExecutorChainOptions {
  prompt: string;
  workdir: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  chain?: ReadonlyArray<string>;
  healthProbe?: HealthProbe;
  harnessRun?: typeof runHarness;
  onEvent?: (event: ExecutorLifecycleEvent) => void;
  onOutput?: (executorId: string, text: string) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runExecutorChain(options: ExecutorChainOptions): Promise<ExecutorChainResult> {
  const chain = options.chain ?? CODER_HARNESS_CHAIN;
  const probe = options.healthProbe ?? defaultHealthProbe();
  const dispatch = options.harnessRun ?? runHarness;
  const emit = options.onEvent ?? (() => {});
  const trail: string[] = [];
  let durationMs = 0;

  emit({
    kind: "exec.start",
    data: {
      chain: [...chain],
      timeout_ms: options.timeoutMs,
      idle_timeout_ms: options.idleTimeoutMs ?? null,
    },
  });

  for (const executorId of chain) {
    let health: { healthy: boolean; message: string };
    try {
      health = await probe(executorId);
    } catch (error) {
      health = { healthy: false, message: `probe threw: ${message(error)}` };
    }

    if (!health.healthy) {
      trail.push(`executor:${executorId}=unhealthy`);
      emit({ kind: "probe.unhealthy", detail: health.message, data: { executor: executorId } });
      continue;
    }

    emit({ kind: "probe.ok", data: { executor: executorId } });
    emit({
      kind: "executor.start",
      data: {
        executor: executorId,
        timeout_ms: options.timeoutMs,
        idle_timeout_ms: options.idleTimeoutMs ?? null,
      },
    });
    try {
      const result: HarnessRunResult = await dispatch(executorId, options.prompt, {
        workdir: options.workdir,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        env: options.env,
        onOutput: (text) => options.onOutput?.(executorId, text),
      });
      durationMs += result.durationMs;
      const seconds = Math.round(result.durationMs / 1000);
      if (result.success) {
        trail.push(`executor:${executorId}=ok(${seconds}s)`);
        emit({ kind: "executor.ok", data: { executor: executorId, seconds } });
        emit({
          kind: "exec.implementation_complete",
          detail: result.output.slice(0, 200),
          data: { executor: executorId },
        });
        return {
          success: true,
          output: result.output,
          executorId,
          durationMs,
          trail,
          error: null,
          modelUsed: result.modelUsed,
          tokensUsed: result.tokensUsed,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          modelProvenance: result.modelProvenance,
        };
      }

      const detail = (result.failureDetail ?? result.output).trim().replace(/\s+/g, " ").slice(0, 200) || "unsuccessful result";
      const failureKind = result.failureKind ?? "execution";
      trail.push(`executor:${executorId}=fail(${seconds}s):${failureKind}:${detail}`);
      emit({ kind: "executor.fail", detail, data: { executor: executorId, seconds, failure_kind: failureKind } });
    } catch (error) {
      const detail = message(error).slice(0, 200);
      const failureKind = classifyHarnessFailureDetail(detail);
      trail.push(`executor:${executorId}=throw:${failureKind}:${detail}`);
      emit({ kind: "executor.throw", detail, data: { executor: executorId, failure_kind: failureKind } });
    }
  }

  const error = `executor chain exhausted (${trail.join(" -> ")})`;
  emit({ kind: "exec.failed", detail: error, data: { trail: [...trail] } });
  return { success: false, output: "", executorId: null, durationMs, trail, error };
}
