/**
 * Composite routing engine with 6-signal scoring
 * 
 * Routes tasks to executors based on capability, health, complexity fit,
 * history, procedure knowledge, and temporal context.
 */

import type { Task, ExecutorCapability, RouteDecision, RoutingStrategy, ComplexityTier } from '../types.js';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';

const STRATEGY_WEIGHTS_6SIGNAL = {
  fast: { capability: 0.12, health: 0.20, complexityFit: 0.40, history: 0.12, procedure: 0.08, temporal: 0.08 },
  reliable: { capability: 0.15, health: 0.35, complexityFit: 0.12, history: 0.18, procedure: 0.12, temporal: 0.08 },
  balanced: { capability: 0.25, health: 0.28, complexityFit: 0.16, history: 0.15, procedure: 0.10, temporal: 0.06 },
  explore: { capability: 0.35, health: 0.16, complexityFit: 0.18, history: 0.16, procedure: 0.10, temporal: 0.05 },
};

const COMPLEXITY_AFFINITY: Record<string, Record<string, number>> = {
  codex: { trivial: 0.90, simple: 0.85, moderate: 0.55, complex: 0.30 },
  gemini: { trivial: 0.75, simple: 0.80, moderate: 0.90, complex: 0.85 },
  hermes: { trivial: 0.70, simple: 0.75, moderate: 0.85, complex: 0.80 },
  'claude-code': { trivial: 0.65, simple: 0.75, moderate: 0.90, complex: 1.00 },
};

export interface RoutingContext {
  strategy: RoutingStrategy;
  useSixSignal: boolean;
  circuitBreakers: CircuitBreakerRegistry;
  executorCapabilities: ExecutorCapability[];
}

export class RoutingEngine {
  private context: RoutingContext;

  constructor(context: RoutingContext) {
    this.context = context;
  }

  route(task: Task, complexityTier: ComplexityTier): RouteDecision {
    const candidates = this.context.executorCapabilities;
    const weights = STRATEGY_WEIGHTS_6SIGNAL[this.context.strategy];
    
    let bestDecision: RouteDecision | null = null;
    let bestScore = -1;

    for (const executor of candidates) {
      const score = this.computeCompositeScore(executor, task, complexityTier);
      
      if (score.compositeScore > bestScore) {
        bestScore = score.compositeScore;
        bestDecision = {
          executorId: executor.id,
          executorName: executor.name,
          compositeScore: score.compositeScore,
          breakdown: score.breakdown,
          method: 'composite',
        };
      }
    }

    return bestDecision || this.getFallbackDecision();
  }

  private computeCompositeScore(
    executor: ExecutorCapability,
    task: Task,
    complexityTier: ComplexityTier
  ): { compositeScore: number; breakdown: RouteDecision['breakdown'] } {
    const weights = STRATEGY_WEIGHTS_6SIGNAL[this.context.strategy];
    const cb = this.context.circuitBreakers.get(executor.id);
    
    // Capability score: how well executor expertise matches task
    const capabilityScore = this.computeCapabilityScore(executor, task);
    
    // Health score: circuit breaker state (1 = healthy, 0 = open)
    const cbState = cb.getState();
    const healthScore = cbState.state === 'CLOSED' ? 1.0 : 
                       cbState.state === 'HALF_OPEN' ? 0.5 : 0.0;
    
    // Complexity fit: affinity between executor and task complexity
    const complexityFit = COMPLEXITY_AFFINITY[executor.id]?.[complexityTier] ?? 0.5;
    
    // History score: past performance (placeholder - would query history DB)
    const historyScore = 0.75; // Default neutral score
    
    // Procedure score: familiarity with task pattern (placeholder)
    const procedureScore = 0.5;
    
    // Temporal score: recency of success (placeholder)
    const temporalScore = cbState.lastSuccess > 0 ? 
      Math.min(1, (Date.now() - cbState.lastSuccess) / (1000 * 60 * 60)) : 0.5;

    const compositeScore = 
      capabilityScore * weights.capability +
      healthScore * weights.health +
      complexityFit * weights.complexityFit +
      historyScore * weights.history +
      procedureScore * weights.procedure +
      temporalScore * weights.temporal;

    return {
      compositeScore,
      breakdown: {
        capability: capabilityScore,
        health: healthScore,
        complexityFit,
        history: historyScore,
        procedure: procedureScore,
        temporal: temporalScore,
      },
    };
  }

  private computeCapabilityScore(executor: ExecutorCapability, task: Task): number {
    const taskLower = task.task.toLowerCase();
    let matchCount = 0;
    
    for (const expertise of executor.expertise) {
      if (taskLower.includes(expertise.toLowerCase())) {
        matchCount++;
      }
    }
    
    return Math.min(1, matchCount / 3); // Cap at 1.0, expect ~3 matches for full score
  }

  private getFallbackDecision(): RouteDecision {
    return {
      executorId: 'claude-code',
      executorName: 'Claude Code',
      compositeScore: 0.5,
      breakdown: {
        capability: 0.5,
        health: 0.5,
        complexityFit: 0.5,
        history: 0.5,
        procedure: 0.5,
        temporal: 0.5,
      },
      method: 'fallback',
    };
  }
}
