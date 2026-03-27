/**
 * DAG execution engine
 * 
 * Executes tasks in dependency order using streaming or wave-based modes.
 */

import type { Task, TaskResult, SwarmConfig } from '../types.js';
import type { BridgeExecutor } from '../executor/bridge.js';

export type ExecutionMode = 'streaming' | 'waves';

export interface ExecutionContext {
  config: SwarmConfig;
  getExecutor: (executorId: string) => BridgeExecutor | undefined;
}

export interface ExecutionProgress {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  inProgressTasks: number;
  percentComplete: number;
}

export class DAGExecutor {
  private tasks: Map<string, Task>;
  private results: Map<string, TaskResult>;
  private inProgress: Set<string>;
  private context: ExecutionContext;

  constructor(tasks: Task[], context: ExecutionContext) {
    this.tasks = new Map(tasks.map(t => [t.id, t]));
    this.results = new Map();
    this.inProgress = new Set();
    this.context = context;
  }

  async execute(mode: ExecutionMode): Promise<TaskResult[]> {
    if (mode === 'streaming') {
      return this.executeStreaming();
    } else {
      return this.executeWaves();
    }
  }

  private async executeStreaming(): Promise<TaskResult[]> {
    const pending = new Set(this.tasks.keys());
    const executing: Promise<void>[] = [];
    const maxConcurrency = this.context.config.localConcurrency;

    const tryExecuteTask = async (taskId: string): Promise<void> => {
      const task = this.tasks.get(taskId);
      if (!task) return;

      // Check dependencies
      const depsSatisfied = (task.dependsOn || []).every(depId => 
        this.results.has(depId) && this.results.get(depId)!.success
      );

      if (!depsSatisfied) {
        // Dependencies not ready, skip for now
        return;
      }

      // Check if already completed
      if (this.results.has(taskId)) {
        pending.delete(taskId);
        return;
      }

      // Check if already in progress
      if (this.inProgress.has(taskId)) {
        return;
      }

      // Execute the task
      this.inProgress.add(taskId);
      pending.delete(taskId);

      try {
        const executor = this.context.getExecutor(task.executor || 'claude-code');
        if (!executor) {
          this.results.set(taskId, {
            task,
            success: false,
            error: `Executor ${task.executor} not found`,
            durationMs: 0,
            retries: 0,
          });
          return;
        }

        const result = await executor.execute(task, {
          timeoutMs: (task.timeoutSeconds || this.context.config.timeoutSeconds) * 1000,
        });

        this.results.set(taskId, result);

        // Notify if configured
        if (this.context.config.notifyOnComplete !== 'none' && !result.success) {
          console.error(`Task ${taskId} failed: ${result.error}`);
        }
      } finally {
        this.inProgress.delete(taskId);
      }
    };

    // Main execution loop
    while (pending.size > 0 || executing.length > 0) {
      // Start new tasks up to concurrency limit
      const availableSlots = maxConcurrency - executing.length;
      const readyTasks = Array.from(pending).filter(taskId => {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        return (task.dependsOn || []).every(depId => 
          this.results.has(depId) && this.results.get(depId)!.success
        );
      }).slice(0, availableSlots);

      for (const taskId of readyTasks) {
        executing.push(tryExecuteTask(taskId));
      }

      // Wait for at least one task to complete
      if (executing.length > 0) {
        await Promise.race(executing);
        // Clean up completed promises
        for (let i = executing.length - 1; i >= 0; i--) {
          const promise = executing[i];
          // Use a quick check - not ideal but works for this pattern
          const timeoutPromise = new Promise<void>((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 0)
          );
          try {
            await Promise.race([promise, timeoutPromise]);
            executing.splice(i, 1);
          } catch {
            // Still running
          }
        }
      } else if (pending.size > 0) {
        // No tasks executing but some pending - likely circular dependency or failed deps
        break;
      }
    }

    return Array.from(this.results.values());
  }

  private async executeWaves(): Promise<TaskResult[]> {
    const remaining = new Set(this.tasks.keys());
    let wave = 0;

    while (remaining.size > 0) {
      wave++;
      
      // Find all tasks with satisfied dependencies
      const readyTasks = Array.from(remaining).filter(taskId => {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        return (task.dependsOn || []).every(depId => 
          this.results.has(depId) && this.results.get(depId)!.success
        );
      });

      if (readyTasks.length === 0) {
        // No ready tasks but still remaining - failed or circular deps
        break;
      }

      console.log(`Wave ${wave}: Executing ${readyTasks.length} tasks`);

      // Execute all ready tasks concurrently (up to concurrency limit)
      const chunks = this.chunkArray(readyTasks, this.context.config.localConcurrency);
      
      for (const chunk of chunks) {
        const promises = chunk.map(async (taskId) => {
          const task = this.tasks.get(taskId)!;
          remaining.delete(taskId);

          const executor = this.context.getExecutor(task.executor || 'claude-code');
          if (!executor) {
            this.results.set(taskId, {
              task,
              success: false,
              error: `Executor ${task.executor} not found`,
              durationMs: 0,
              retries: 0,
            });
            return;
          }

          const result = await executor.execute(task, {
            timeoutMs: (task.timeoutSeconds || this.context.config.timeoutSeconds) * 1000,
          });

          this.results.set(taskId, result);
        });

        await Promise.all(promises);
      }
    }

    // Mark remaining tasks as failed (unmet dependencies)
    for (const taskId of remaining) {
      const task = this.tasks.get(taskId)!;
      this.results.set(taskId, {
        task,
        success: false,
        error: 'Dependencies not satisfied or circular dependency detected',
        durationMs: 0,
        retries: 0,
      });
    }

    return Array.from(this.results.values());
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  getProgress(): ExecutionProgress {
    const total = this.tasks.size;
    const completed = Array.from(this.results.values()).filter(r => r.success).length;
    const failed = Array.from(this.results.values()).filter(r => !r.success).length;
    
    return {
      totalTasks: total,
      completedTasks: completed,
      failedTasks: failed,
      inProgressTasks: this.inProgress.size,
      percentComplete: Math.round(((completed + failed) / total) * 100),
    };
  }
}
