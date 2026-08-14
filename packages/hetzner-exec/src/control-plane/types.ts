export type ShadowJobStatus =
  | "queued"
  | "leased"
  | "retry_wait"
  | "completed"
  | "cancelled"
  | "dead_letter";

export interface ShadowJobSource {
  assignment_id: string;
  campaign_id: string;
  task_id: string;
}

export interface ShadowJobMetadata {
  identifier?: string;
  name?: string;
  target_repository?: string;
  attempt?: number;
}

export interface ShadowJobInput {
  idempotency_key: string;
  source: ShadowJobSource;
  metadata?: ShadowJobMetadata;
}

export interface ShadowLease {
  lease_id: string;
  worker_id: string;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
}

export interface ShadowCheckpoint {
  stage: "accepted" | "claimed" | "heartbeat" | "shadow-verified" | "retry" | "terminal";
  recorded_at: string;
  detail?: string;
}

export interface ShadowJob {
  job_id: string;
  mode: "shadow";
  idempotency_key: string;
  source: ShadowJobSource;
  metadata: ShadowJobMetadata;
  status: ShadowJobStatus;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  next_attempt_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  lease: ShadowLease | null;
  latest_checkpoint: ShadowCheckpoint;
  last_error: string | null;
  result: { shadow_verified: true; summary: string } | null;
}

export type ShadowEventType =
  | "job.accepted"
  | "job.deduplicated"
  | "job.claimed"
  | "job.heartbeat"
  | "job.shadow_verified"
  | "job.retry_scheduled"
  | "job.cancelled"
  | "job.dead_lettered"
  | "job.lease_expired";

export interface ShadowEvent {
  event_id: string;
  job_id: string;
  type: ShadowEventType;
  recorded_at: string;
  detail?: string;
}

export interface ShadowTickResult {
  action: "idle" | "completed" | "retry_scheduled" | "dead_lettered";
  job_id?: string;
}

export interface ShadowReconcileResult {
  recovered: number;
  dead_lettered: number;
}
