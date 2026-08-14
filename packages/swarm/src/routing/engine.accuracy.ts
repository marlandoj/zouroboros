#!/usr/bin/env bun
/**
 * Routing accuracy benchmark — outputs a 0..1 fraction of correct decisions.
 * Used as metricCommand for the E-routing-weights autoloop.
 */

import { RoutingEngine } from './engine.js';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';
import type { ExecutorCapability, Task, ComplexityTier } from '../types.js';

const executors: ExecutorCapability[] = [
  { id: 'codex',       name: 'Codex',       expertise: ['typescript', 'javascript'], bestFor: [], isLocal: true },
  { id: 'gemini',      name: 'Gemini',      expertise: ['frontend', 'ui', 'visual'],  bestFor: [], isLocal: true },
  { id: 'hermes',      name: 'Hermes',      expertise: ['research', 'web', 'analysis'], bestFor: [], isLocal: true },
  { id: 'opencode',    name: 'OpenCode',    expertise: ['backend', 'database', 'api'], bestFor: [], isLocal: true },
  { id: 'claude-code', name: 'Claude Code', expertise: ['architecture', 'planning', 'reasoning'], bestFor: [], isLocal: true },
];

interface Case {
  task: Task;
  tier: ComplexityTier;
  expected: string;
}

// Cases derived from COMPLEXITY_AFFINITY + capability keyword matching.
// Capability match always wins when capability_weight * 1.0 + complexity_fit * affinity
// exceeds best non-matching competitor at the given tier (verified for 'fast' strategy).
const cases: Case[] = [
  // Capability keyword matches — each executor's expertise signals a clear winner
  { task: { id: '1', persona: 'p', task: 'Fix the typescript error in the file', priority: 'medium' }, tier: 'trivial', expected: 'codex' },
  { task: { id: '2', persona: 'p', task: 'Build the frontend ui component',       priority: 'medium' }, tier: 'simple',   expected: 'gemini' },
  { task: { id: '3', persona: 'p', task: 'Research web competitors and analysis', priority: 'medium' }, tier: 'moderate', expected: 'hermes' },
  { task: { id: '4', persona: 'p', task: 'Design the database backend schema',    priority: 'medium' }, tier: 'moderate', expected: 'opencode' },
  { task: { id: '5', persona: 'p', task: 'Architecture planning and reasoning',   priority: 'medium' }, tier: 'complex',  expected: 'claude-code' },

  // No keyword match — complexity affinity alone determines winner (fast strategy weights)
  { task: { id: '6', persona: 'p', task: 'Do something unrelated',               priority: 'medium' }, tier: 'complex',  expected: 'claude-code' }, // affinity 1.00
  { task: { id: '7', persona: 'p', task: 'Do something unrelated',               priority: 'medium' }, tier: 'trivial',  expected: 'codex' },       // affinity 0.90
  { task: { id: '8', persona: 'p', task: 'Do something unrelated',               priority: 'medium' }, tier: 'simple',   expected: 'opencode' },    // affinity 0.90, first
  { task: { id: '9', persona: 'p', task: 'Do something unrelated',               priority: 'medium' }, tier: 'moderate', expected: 'gemini' },      // 3-way tie, first
];

const engine = new RoutingEngine({
  strategy: 'fast',
  useSixSignal: true,
  circuitBreakers: new CircuitBreakerRegistry(),
  executorCapabilities: executors,
});

let correct = 0;
for (const c of cases) {
  const decision = engine.route(c.task, c.tier);
  if (decision.executorId === c.expected) correct++;
}

console.log((correct / cases.length).toFixed(4));
