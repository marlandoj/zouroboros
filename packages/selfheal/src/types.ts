/**
 * Types for Zouroboros Self-Heal
 *
 * @module zouroboros-selfheal/types
 */

import type { ExpectedStateChange } from './evolve/intervention-ledger.js';
import type { SelfHealPlanGateShadow } from './prescribe/plan-gate.js';

export type MetricStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'INSUFFICIENT_EVIDENCE';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface MetricResult {
  name: string;
  value: number;
  target: number;
  critical: number;
  weight: number;
  score: number;
  status: MetricStatus;
  trend: '↑' | '↓' | '→' | '—';
  detail: string;
  recommendation: string;
}

export interface Scorecard {
  timestamp: string;
  composite: number;
  metrics: MetricResult[];
  weakest: string;
  topOpportunities: { metric: string; action: string; impact: number }[];
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  targetFile: string | null;
  metricCommand: string;
  metricDirection: 'higher_is_better' | 'lower_is_better';
  constraints: string[];
  maxFiles: number;
  requiresApproval: boolean;
  approvalReason?: string;
  setupCommands?: string[];
  runCommand?: string;
  readOnlyFiles?: string[];
  /**
   * Operator-declared cheap DETERMINISTIC command that attempts the task (roadmap #11).
   * When present, the evolve loop's regime gate runs it before escalating to the expensive
   * autoloop, so a metric a sub-second command already satisfies never burns the 8h budget.
   * Absent ⇒ the regime gate is a no-op (byte-identical to today).
   */
  cheapProbeCommand?: string;
}

export interface Prescription {
  id: string;
  timestamp: string;
  metric: MetricResult;
  playbook: Playbook;
  seed: string;
  program: string | null;
  governor: GovernorReport;
  /**
   * Causal context for this playbook from the intervention ledger (ZOU-280): the
   * expected state-change derived from past applications. null when the playbook has
   * no recorded history yet (prescribe falls back to its correlational selection).
   */
  expectedStateChange?: ExpectedStateChange | null;
  planGateShadow?: SelfHealPlanGateShadow;
}

export interface GovernorReport {
  approved: boolean;
  flags: string[];
  riskLevel: RiskLevel;
  requiresHuman: boolean;
  reason: string;
}

export interface EvolutionResult {
  prescriptionId: string;
  success: boolean;
  baseline: ScorecardSnapshot;
  postFlight: ScorecardSnapshot | null;
  delta: number;
  reverted: boolean;
  detail: string;
  /**
   * Process-supervised trajectory (M10 W4 t12). Records per-step outcomes
   * across setup → run → measure phases so downstream readers can locate
   * failures without parsing `detail`. Optional/additive — older callers
   * remain unaffected.
   */
  trajectorySteps?: TrajectoryStep[];
  /**
   * Aggregated process-reward score (mean of step scores). 0..1.
   * Distinct from outcome-only `success`/`delta` — captures *how much*
   * of the trajectory succeeded.
   */
  processReward?: number;
}

export interface TrajectoryStep {
  index: number;
  name: string;
  phase: 'setup' | 'run' | 'measure' | 'autoloop';
  outcome: 'success' | 'failure' | 'partial' | 'skipped';
  score: number;
  durationMs: number;
  detail?: string;
}

export interface ScorecardSnapshot {
  composite: number;
  metrics: { name: string; value: number; score: number; status: string }[];
}
