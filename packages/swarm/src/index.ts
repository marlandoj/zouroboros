/**
 * Zouroboros Swarm
 * 
 * Multi-agent orchestration with circuit breakers, 6-signal routing, and DAG execution.
 * 
 * @module zouroboros-swarm
 */

// Core types
export type {
  Task,
  TaskResult,
  SwarmConfig,
  ExecutorCapability,
  ExecutorRegistryEntry,
  RouteDecision,
  RoutingStrategy,
  DAGMode,
  ErrorCategory,
  CircuitBreakerState,
} from './types.js';

// Circuit breaker
export { CircuitBreaker, CircuitBreakerRegistry } from './circuit/breaker.js';

// Routing
export { RoutingEngine, type RoutingContext } from './routing/engine.js';

// Registry
export { loadRegistry, findExecutor, listExecutors, getLocalExecutors } from './registry/loader.js';

// Executor
export { BridgeExecutor, type BridgeExecutionOptions } from './executor/bridge.js';

// DAG
export { DAGExecutor, type ExecutionContext, type ExecutionProgress } from './dag/executor.js';

// Main orchestrator
export { SwarmOrchestrator } from './orchestrator.js';
