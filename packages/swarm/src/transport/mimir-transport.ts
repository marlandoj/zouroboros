/**
 * MimirTransport — lightweight transport that queries the memory gate's Mimir persona.
 *
 * Unlike BridgeTransport/ACPTransport which spawn full LLM sessions, this transport
 * makes a single HTTP POST to the memory gate daemon. The gate handles retrieval +
 * Karpathy 2nd Brain synthesis. Typical latency: 2-5s.
 *
 * Used by the "memory-sage" role to inject historical context into downstream DAG nodes.
 */

import type { Task, TaskResult } from '../types.js';
import type {
  ExecutorTransport,
  TransportOptions,
  SessionUpdate,
  HealthStatus,
} from './types.js';

async function* emptyAsyncIterable(): AsyncIterable<SessionUpdate> {}

export class MimirTransport implements ExecutorTransport {
  private gateUrl: string;

  constructor(gateUrl: string = 'http://localhost:7820') {
    this.gateUrl = gateUrl;
  }

  async execute(task: Task, options: TransportOptions): Promise<TaskResult> {
    const start = Date.now();

    try {
      const resp = await fetch(`${this.gateUrl}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: task.task, persona: 'mimir' }),
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      });

      if (!resp.ok) {
        return {
          task,
          success: false,
          error: `Memory gate returned ${resp.status}`,
          output: '',
          durationMs: Date.now() - start,
          retries: 0,
          effectiveExecutor: 'mimir',
        };
      }

      const data = await resp.json() as {
        exit_code: number;
        method: string;
        output: string;
        latency_ms: number;
      };

      // exit_code 0 = found context, 2 = skip, 3 = needed-but-empty
      if (data.exit_code === 0 && data.output) {
        return {
          task,
          success: true,
          output: data.output,
          durationMs: Date.now() - start,
          retries: 0,
          effectiveExecutor: 'mimir',
        };
      }

      // No relevant context — still success (sage has nothing to add)
      return {
        task,
        success: true,
        output: 'No relevant historical context found for this task.',
        durationMs: Date.now() - start,
        retries: 0,
        effectiveExecutor: 'mimir',
      };
    } catch (err) {
      return {
        task,
        success: false,
        error: `Mimir gate error: ${err}`,
        output: '',
        durationMs: Date.now() - start,
        retries: 0,
        effectiveExecutor: 'mimir',
      };
    }
  }

  executeWithUpdates(task: Task, options: TransportOptions): {
    updates: AsyncIterable<SessionUpdate>;
    result: Promise<TaskResult>;
  } {
    return {
      updates: emptyAsyncIterable(),
      result: this.execute(task, options),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const resp = await fetch(`${this.gateUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return { healthy: false, message: `Gate returned ${resp.status}` };
      }
      const data = await resp.json() as {
        status: string;
        backends?: Record<string, { exists: boolean; facts: number }>;
      };

      const mimirBackend = data.backends?.mimir;
      if (!mimirBackend || !mimirBackend.exists) {
        return { healthy: false, message: 'Mimir backend not configured or missing' };
      }

      return {
        healthy: true,
        message: `Gate ok, mimir.db has ${mimirBackend.facts} facts`,
      };
    } catch (err) {
      return { healthy: false, message: `Gate unreachable: ${err}` };
    }
  }

  async shutdown(): Promise<void> {
    // No-op — gate daemon lifecycle managed externally
  }
}
