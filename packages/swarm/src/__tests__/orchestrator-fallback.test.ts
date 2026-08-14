import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { SwarmOrchestrator } from '../orchestrator.js';
import { closeDb } from '../db/schema.js';
import type { Task, TaskResult } from '../types.js';
import type {
  ExecutorTransport,
  HealthStatus,
  SessionUpdate,
  TransportOptions,
} from '../transport/types.js';

const TEST_DB = '/tmp/swarm-orchestrator-fallback.db';

function transport(result: (task: Task) => TaskResult): ExecutorTransport {
  return {
    async execute(task: Task, _options: TransportOptions): Promise<TaskResult> {
      return result(task);
    },
    executeWithUpdates(task: Task, options: TransportOptions) {
      return {
        updates: (async function* (): AsyncIterable<SessionUpdate> {})(),
        result: this.execute(task, options),
      };
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true };
    },
    async shutdown(): Promise<void> {},
  };
}

describe('SwarmOrchestrator fallback resolution', () => {
  afterEach(() => {
    closeDb();
    delete process.env.SWARM_HARNESS_SMOKE;
    for (const path of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  test('attaches fallbacks to an explicit executor and recovers on failure', async () => {
    process.env.SWARM_HARNESS_SMOKE = '0';
    const orchestrator = new SwarmOrchestrator({
      dbPath: TEST_DB,
      enableMemory: false,
      maxRetries: 0,
      pipelineGates: {
        seedValidation: false,
        postFlightEval: false,
        gapAuditLoop: false,
        blockOnSeedFailure: false,
      },
    });

    const transports = (orchestrator as unknown as {
      transports: Map<string, ExecutorTransport>;
    }).transports;
    transports.set('claude-code', transport((task) => ({
      task,
      success: false,
      error: 'quota exhausted',
      durationMs: 1,
      retries: 0,
    })));
    transports.set('gemini', transport((task) => ({
      task,
      success: true,
      output: 'CONVEYOR_OK',
      durationMs: 1,
      retries: 0,
    })));

    const task: Task = {
      id: 'explicit-primary',
      persona: 'claude-code',
      task: 'Return CONVEYOR_OK.',
      priority: 'high',
      executor: 'claude-code',
    };
    const [result] = await orchestrator.run([task]);

    expect(task.fallbackExecutors?.[0]).toBe('gemini');
    expect(result.success).toBe(true);
    expect(result.output).toBe('CONVEYOR_OK');
    expect(result.effectiveExecutor).toBe('gemini');
    expect(result.fallbacksAttempted).toBe(1);
  });
});
