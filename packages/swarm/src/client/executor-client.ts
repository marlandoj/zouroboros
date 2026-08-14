/**
 * ExecutorClient — RAG-enriched per-executor SDK
 *
 * Thin wrapper over ExecutorTransport that:
 *   1. Loads the executor entry from the registry
 *   2. Wires a CircuitBreaker + creates the correct transport
 *   3. Auto-enriches prompts with RAG context before dispatch
 *      (keyword-triggered by default, forceable via options.forceRAG)
 *
 * Usage:
 *   const client = await ExecutorClient.for('claude-code');
 *   const result = await client.run('Refactor the router to support streaming');
 */

import { randomUUID } from 'crypto';
import { CircuitBreaker } from '../circuit/breaker.js';
import { loadRegistry, findExecutor } from '../registry/loader.js';
import { createTransport } from '../transport/factory.js';
import { enrichTaskWithRAG, shouldEnrichWithRAG } from '../rag/enrichment.js';
import type { ExecutorTransport, SessionUpdate } from '../transport/types.js';
import type { ExecutorRegistryEntry, Task, TaskResult } from '../types.js';

export interface ExecutorClientOptions {
  /** Force RAG enrichment even when keywords don't trigger it. Default: false */
  forceRAG?: boolean;
  /** Override RAG collections. Defaults to all 5 local collections. */
  ragCollections?: string[];
  /** RAG top-K results. Default: 5 */
  ragTopK?: number;
  /** Minimum RAG score threshold. Default: 0.65 */
  ragMinScore?: number;
  /** Task timeout in ms. Default: 120_000 */
  timeoutMs?: number;
  /** Cancel an ACP session after this long without a session update. */
  idleTimeoutMs?: number;
  /** Working directory passed to the executor. */
  workdir?: string;
  /** Custom env vars merged into executor env. */
  env?: Record<string, string>;
  /** Custom registry path override. */
  registryPath?: string;
  /** Live-observation tap for streaming session updates (ACP transports only). */
  onUpdate?: (update: SessionUpdate) => void;
}

export interface RunResult {
  output: string;
  ragContext: string;
  ragPatterns: number;
  ragLatencyMs: number;
  executorId: string;
  taskId: string;
  success: boolean;
  durationMs: number;
  raw: TaskResult;
}

export class ExecutorClient {
  readonly executorId: string;

  private constructor(
    private readonly entry: ExecutorRegistryEntry,
    private readonly transport: ExecutorTransport,
  ) {
    this.executorId = entry.id;
  }

  /**
   * Create a client for the named executor.
   * Throws if the executor is not found in the registry.
   */
  static async for(
    executorId: string,
    opts: Pick<ExecutorClientOptions, 'registryPath'> = {},
  ): Promise<ExecutorClient> {
    const registry = loadRegistry(opts.registryPath);
    const entry = findExecutor(registry, executorId);
    if (!entry) {
      const available = registry.executors.map(e => e.id).join(', ');
      throw new Error(
        `Executor '${executorId}' not found in registry. Available: ${available}`,
      );
    }
    const cb = new CircuitBreaker();
    const transport = createTransport(entry, cb);
    return new ExecutorClient(entry, transport);
  }

  /** Test-only factory — inject transport directly without loading the registry. */
  static _withTransport(entry: ExecutorRegistryEntry, transport: ExecutorTransport): ExecutorClient {
    return new ExecutorClient(entry, transport);
  }

  /** Convenience factories */
  static claudeCode(opts?: Pick<ExecutorClientOptions, 'registryPath'>) {
    return ExecutorClient.for('claude-code', opts);
  }
  static codex(opts?: Pick<ExecutorClientOptions, 'registryPath'>) {
    return ExecutorClient.for('codex', opts);
  }
  static gemini(opts?: Pick<ExecutorClientOptions, 'registryPath'>) {
    return ExecutorClient.for('gemini', opts);
  }
  static hermes(opts?: Pick<ExecutorClientOptions, 'registryPath'>) {
    return ExecutorClient.for('hermes', opts);
  }
  static openCode(opts?: Pick<ExecutorClientOptions, 'registryPath'>) {
    return ExecutorClient.for('opencode', opts);
  }
  static mimir(opts?: Pick<ExecutorClientOptions, 'registryPath'>) {
    return ExecutorClient.for('mimir', opts);
  }

  /**
   * Run a prompt through the executor with optional RAG enrichment.
   * RAG triggers automatically on keyword match unless forceRAG=true.
   */
  async run(prompt: string, opts: ExecutorClientOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const taskId = randomUUID();

    const shouldEnrich = opts.forceRAG || shouldEnrichWithRAG(prompt);
    let ragContext = '';
    let ragPatterns = 0;
    let ragLatencyMs = 0;

    if (shouldEnrich) {
      const ragResult = await enrichTaskWithRAG(prompt, {
        collections: opts.ragCollections,
        topK: opts.ragTopK ?? 5,
        minScore: opts.ragMinScore ?? 0.65,
      });
      ragContext = ragResult.context;
      ragPatterns = ragResult.patterns;
      ragLatencyMs = ragResult.latencyMs;
    }

    const enrichedPrompt = ragContext ? `${ragContext}\n\n${prompt}` : prompt;

    const task: Task = {
      id: taskId,
      persona: 'alaric',
      task: enrichedPrompt,
      priority: 'medium',
      executor: this.executorId,
      ragContext,
    };

    const result = await this.transport.execute(task, {
      timeoutMs: opts.timeoutMs ?? 120_000,
      idleTimeoutMs: opts.idleTimeoutMs,
      workdir: opts.workdir,
      env: opts.env,
      onUpdate: opts.onUpdate,
    });

    return {
      output: result.output ?? '',
      ragContext,
      ragPatterns,
      ragLatencyMs,
      executorId: this.executorId,
      taskId,
      success: result.success,
      durationMs: Date.now() - start,
      raw: result,
    };
  }

  /** Health check passthrough. */
  async health() {
    return this.transport.healthCheck();
  }

  /** Release transport resources. */
  async dispose() {
    return this.transport.shutdown();
  }
}
