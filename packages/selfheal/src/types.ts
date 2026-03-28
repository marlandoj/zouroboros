/**
 * Types for Zouroboros Self-Heal
 * 
 * @module zouroboros-selfheal/types
 */

export type MetricStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';
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
}

export interface Prescription {
  id: string;
  timestamp: string;
  metric: MetricResult;
  playbook: Playbook;
  seed: string;
  program: string | null;
  governor: GovernorReport;
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
}

export interface ScorecardSnapshot {
  composite: number;
  metrics: { name: string; value: number; score: number; status: string }[];
}
