/**
 * Skill Crystallization v1 — type definitions
 *
 * Mirrors DB enums declared in packages/memory/src/database.ts SCHEMA_SQL
 * (CHECK constraints on `crystallizations` and `crystallization_events`).
 *
 * Source ontology — see seed-skill-crystallization-v1.draft.yaml `ontology`.
 */

export type SourceKind = 'procedure' | 'episode' | 'skill_execution' | 'mixed';

export type EvalStatus =
  | 'pending'
  | 'mechanical_pass'
  | 'mechanical_fail'
  | 'replay_pass'
  | 'replay_fail'
  | 'mechanical_only'
  | 'complete';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type TriggerKind = 'cron' | 'event_hook' | 'manual';

export type EventType =
  | 'created'
  | 'mechanical_eval'
  | 'replay_eval'
  | 'email_sent'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'promoted'
  | 'reverted'
  | 'threshold_changed';

export const EVOLUTION_BUNDLE_SCHEMA_VERSION = '1.0.0';

export interface EvolutionCandidateBundle {
  schema_version: typeof EVOLUTION_BUNDLE_SCHEMA_VERSION;
  candidate_version: string;
  slug: string;
  playbook_id: string;
  source_signature: string;
  weighted_score: number;
  source_ids: string[];
  files: Array<{ path: string; content: string }>;
  provenance: {
    prescription_id: string;
    metric_name: string;
    result_hash: string;
    generated_at: string;
  };
}

export interface CrystallizationRow {
  id: string;
  slug: string;
  source_kind: SourceKind;
  source_ids: string[];
  source_signature: string;
  weighted_score: number;
  draft_path: string;
  promoted_path: string | null;
  eval_status: EvalStatus;
  approval_status: ApprovalStatus;
  approval_token_prefix_8: string | null;
  trigger_kind: TriggerKind;
  llm_cost_usd: number;
  created_at: number;
  evaluated_at: number | null;
  approved_at: number | null;
  expires_at: number;
}

export interface CrystallizationEvent {
  id: number;
  crystallization_id: string;
  event_type: EventType;
  payload: Record<string, unknown> | null;
  created_at: number;
}

export interface ProcedureSource {
  kind: 'procedure';
  id: string;
  name: string;
  steps: unknown[];
  success_count: number;
  failure_count: number;
}

export interface EpisodeSource {
  kind: 'episode';
  id: string;
  summary: string;
  outcome: 'success' | 'resolved';
  happened_at: number;
}

export interface SkillExecutionSource {
  kind: 'skill_execution';
  id: string;
  skill_name: string;
  outcome: 'success';
  happened_at: number;
}

export type SourceRow = ProcedureSource | EpisodeSource | SkillExecutionSource;

export interface Candidate {
  /** Cluster of source rows that together cross the weighted-score threshold. */
  sources: SourceRow[];
  /** Sum of source weights (procedure=1.0, episode=0.4, skill_execution=0.5). */
  score: number;
  /** Mixed if the cluster spans more than one kind. */
  source_kind: SourceKind;
  /** Stable, sorted-by-id sha256 hex of source_ids — UNIQUE constraint on row. */
  source_signature: string;
  /** Slug suggestion (collision-suffixed at draft time). */
  slug_suggestion: string;
}

export interface ScoringConfig {
  /** Default 3.0; lowered to 2.0 in cold-start window. */
  threshold: number;
  /** Weights — fixed by seed; exposed for tests only. */
  weights: { procedure: number; episode: number; skill_execution: number };
}

export const DEFAULT_WEIGHTS = {
  procedure: 1.0,
  episode: 0.4,
  skill_execution: 0.5,
} as const;

export const NORMAL_THRESHOLD = 3.0;
export const COLD_START_THRESHOLD = 2.0;
export const COLD_START_WINDOW_DAYS = 30;
export const APPROVAL_TTL_DAYS = 14;
export const PENDING_CAPACITY_CEILING = 5;
