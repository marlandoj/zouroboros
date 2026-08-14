/**
 * Bridge executor for local executors
 * 
 * Invokes executor bridge scripts (shell scripts that wrap CLI tools).
 */

import { spawn } from 'child_process';
import { isAbsolute, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { Task, TaskResult, ExecutorRegistryEntry, ErrorCategory } from '../types.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import { parseTaskResult, SchemaValidationError } from '../schemas/swarm-schemas.js';

export interface BridgeExecutionOptions {
  timeoutMs: number;
  workdir?: string;
  env?: Record<string, string>;
  context?: Record<string, unknown>;
}

export class BridgeExecutor {
  private registryEntry: ExecutorRegistryEntry;
  private circuitBreaker: CircuitBreaker;

  constructor(registryEntry: ExecutorRegistryEntry, circuitBreaker: CircuitBreaker) {
    this.registryEntry = registryEntry;
    this.circuitBreaker = circuitBreaker;
  }

  async execute(task: Task, options: BridgeExecutionOptions): Promise<TaskResult> {
    // Check circuit breaker
    if (!this.circuitBreaker.canAttempt()) {
      return {
        task,
        success: false,
        error: `Circuit breaker OPEN for executor ${this.registryEntry.id}`,
        durationMs: 0,
        retries: 0,
      };
    }

    const startTime = Date.now();
    const bridgePath = this.registryEntry.bridge;
    
    if (!bridgePath) {
      this.circuitBreaker.recordFailure('unknown');
      return {
        task,
        success: false,
        error: `No bridge defined for executor ${this.registryEntry.id}`,
        durationMs: 0,
        retries: 0,
      };
    }

    const fullBridgePath = isAbsolute(bridgePath)
      ? bridgePath
      : join(getWorkspaceRoot(), bridgePath);
    const workdir = options.workdir || getWorkspaceRoot();
    const resultPath = join('/tmp', `swarm-bridge-${task.id}-${randomUUID()}.json`);

    return new Promise((resolve) => {
      const child = spawn('bash', [fullBridgePath, task.task, workdir], {
        cwd: workdir,
        env: { ...process.env, ...options.env, SWARM_TASK_ID: task.id, RESULT_PATH: resultPath },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        let structuredOutput: string | undefined;
        let structuredArtifacts: string[] | undefined;
        let structuredModel: string | undefined;

        try {
          if (existsSync(resultPath)) {
            const structured = parseTaskResult(readFileSync(resultPath, 'utf8'));
            if (typeof structured.output === 'string') {
              structuredOutput = structured.output;
            }
            structuredModel = structured.modelUsed;
            structuredArtifacts = [
              ...(Array.isArray(structured.artifacts) ? structured.artifacts : []),
            ];
          }
        } catch (err) {
          if (err instanceof SchemaValidationError) {
            console.error(`[bridge] Schema validation warning for ${task.id}: ${err.message}`);
            // Fallback: try legacy unstructured parse for backward compat
            try {
              const raw = JSON.parse(readFileSync(resultPath, 'utf8'));
              if (typeof raw.output === 'string') structuredOutput = raw.output;
              structuredModel = raw.metrics?.model;
              structuredArtifacts = [
                ...(Array.isArray(raw.artifacts?.filesCreated) ? raw.artifacts.filesCreated : []),
                ...(Array.isArray(raw.artifacts?.filesModified) ? raw.artifacts.filesModified : []),
                ...(Array.isArray(raw.artifacts?.filesDeleted) ? raw.artifacts.filesDeleted : []),
              ];
            } catch {}
          }
        }
        try { unlinkSync(resultPath); } catch {}
        
        if (code === 0) {
          this.circuitBreaker.recordSuccess();
          resolve({
            task,
            success: true,
            output: structuredOutput ?? stdout,
            durationMs,
            retries: 0,
            artifacts: structuredArtifacts,
            modelUsed: structuredModel,
          });
        } else {
          const errorCategory = this.classifyError(stderr, code);
          this.circuitBreaker.recordFailure(errorCategory);
          resolve({
            task,
            success: false,
            error: stderr || stdout || `Process exited with code ${code}`,
            durationMs,
            retries: 0,
          });
        }
      });

      child.on('error', (err) => {
        const durationMs = Date.now() - startTime;
        this.circuitBreaker.recordFailure('runtime_error');
        resolve({
          task,
          success: false,
          error: `Failed to spawn process: ${err.message}`,
          durationMs,
          retries: 0,
        });
      });
    });
  }

  private classifyError(stderr: string, code: number | null): ErrorCategory {
    const lowerStderr = stderr.toLowerCase();
    
    if (code === null || lowerStderr.includes('timeout') || lowerStderr.includes('timed out')) {
      return 'timeout';
    }
    if (lowerStderr.includes('rate limit') || lowerStderr.includes('429')) {
      return 'rate_limited';
    }
    if (lowerStderr.includes('permission') || lowerStderr.includes('denied') || lowerStderr.includes('403')) {
      return 'permission_denied';
    }
    if (lowerStderr.includes('context') || lowerStderr.includes('token')) {
      return 'context_overflow';
    }
    if (lowerStderr.includes('syntax') || lowerStderr.includes('parse')) {
      return 'syntax_error';
    }
    if (lowerStderr.includes('runtime') || lowerStderr.includes('error')) {
      return 'runtime_error';
    }
    
    return 'unknown';
  }
}
