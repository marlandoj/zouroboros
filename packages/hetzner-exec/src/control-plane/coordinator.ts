import { randomUUID } from "node:crypto";
import { ControlPlaneStore } from "./store";
import type {
  ShadowEventType,
  ShadowJob,
  ShadowJobInput,
  ShadowJobMetadata,
  ShadowReconcileResult,
  ShadowTickResult,
} from "./types";

export interface ShadowExecutor {
  run(job: ShadowJob): Promise<{ summary: string }>;
}

export interface CoordinatorOptions {
  workerId?: string;
  leaseTtlMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  executor?: ShadowExecutor;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class ShadowCoordinator {
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly executor: ShadowExecutor;

  constructor(readonly store: ControlPlaneStore, options: CoordinatorOptions = {}) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.leaseTtlMs = positiveInteger(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, "leaseTtlMs");
    this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "retryBaseMs");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.now = options.now ?? (() => new Date());
    this.executor = options.executor ?? new NoSideEffectShadowExecutor();
  }

  submit(raw: unknown): { job: ShadowJob; deduplicated: boolean } {
    const input = validateInput(raw);
    return this.store.withLock(() => {
      const index = this.store.readIdempotency();
      const existingId = index[input.idempotency_key];
      if (existingId) {
        const existing = this.store.readJob(existingId);
        if (!existing) throw new Error(`idempotency index points to missing job: ${existingId}`);
        this.event(existing.job_id, "job.deduplicated");
        return { job: existing, deduplicated: true };
      }
      const timestamp = this.now().toISOString();
      const job: ShadowJob = {
        job_id: `job-${randomUUID()}`,
        mode: "shadow",
        idempotency_key: input.idempotency_key,
        source: input.source,
        metadata: input.metadata ?? {},
        status: "queued",
        attempt_count: 0,
        max_attempts: this.maxAttempts,
        created_at: timestamp,
        updated_at: timestamp,
        next_attempt_at: timestamp,
        completed_at: null,
        cancelled_at: null,
        lease: null,
        latest_checkpoint: { stage: "accepted", recorded_at: timestamp },
        last_error: null,
        result: null,
      };
      this.store.writeJob(job);
      this.store.writeIdempotency({ ...index, [job.idempotency_key]: job.job_id });
      this.event(job.job_id, "job.accepted");
      return { job, deduplicated: false };
    });
  }

  list(): ShadowJob[] {
    return this.store.listJobs();
  }

  get(jobId: string): ShadowJob | null {
    return this.store.readJob(jobId);
  }

  cancel(jobId: string): ShadowJob | null {
    return this.store.withLock(() => {
      const job = this.store.readJob(jobId);
      if (!job) return null;
      if (["completed", "cancelled", "dead_letter"].includes(job.status)) return job;
      const timestamp = this.now().toISOString();
      const next: ShadowJob = {
        ...job,
        status: "cancelled",
        updated_at: timestamp,
        cancelled_at: timestamp,
        next_attempt_at: null,
        lease: null,
        latest_checkpoint: { stage: "terminal", recorded_at: timestamp, detail: "cancelled" },
      };
      this.store.writeJob(next);
      this.event(jobId, "job.cancelled");
      return next;
    });
  }

  renew(jobId: string, leaseId: string): ShadowJob | null {
    return this.store.withLock(() => {
      const job = this.store.readJob(jobId);
      if (!job || job.status !== "leased" || job.lease?.lease_id !== leaseId) return null;
      const timestamp = this.now();
      const next: ShadowJob = {
        ...job,
        updated_at: timestamp.toISOString(),
        lease: {
          ...job.lease,
          renewed_at: timestamp.toISOString(),
          expires_at: new Date(timestamp.getTime() + this.leaseTtlMs).toISOString(),
        },
        latest_checkpoint: { stage: "heartbeat", recorded_at: timestamp.toISOString() },
      };
      this.store.writeJob(next);
      this.event(jobId, "job.heartbeat");
      return next;
    });
  }

  reconcile(): ShadowReconcileResult {
    return this.store.withLock(() => {
      const now = this.now();
      let recovered = 0;
      let deadLettered = 0;
      for (const job of this.store.listJobs()) {
        if (job.status !== "leased" || !job.lease || new Date(job.lease.expires_at).getTime() > now.getTime()) continue;
        const exhausted = job.attempt_count >= job.max_attempts;
        const next = exhausted
          ? this.toDeadLetter(job, now, "lease expired after final attempt")
          : this.toRetry(job, now, "lease expired during restart reconciliation");
        this.store.writeJob(next);
        this.event(job.job_id, exhausted ? "job.dead_lettered" : "job.lease_expired", next.last_error ?? undefined);
        if (exhausted) deadLettered++;
        else recovered++;
      }
      return { recovered, dead_lettered: deadLettered };
    });
  }

  async tick(): Promise<ShadowTickResult> {
    this.reconcile();
    const claimed = this.claimNext();
    if (!claimed) return { action: "idle" };
    try {
      const result = await this.executor.run(claimed);
      return this.complete(claimed, result.summary);
    } catch (error) {
      return this.fail(claimed, error);
    }
  }

  private claimNext(): ShadowJob | null {
    return this.store.withLock(() => {
      const now = this.now();
      const candidate = this.store.listJobs().find((job) =>
        (job.status === "queued" || job.status === "retry_wait") &&
        job.next_attempt_at !== null &&
        new Date(job.next_attempt_at).getTime() <= now.getTime(),
      );
      if (!candidate) return null;
      const timestamp = now.toISOString();
      const next: ShadowJob = {
        ...candidate,
        status: "leased",
        attempt_count: candidate.attempt_count + 1,
        updated_at: timestamp,
        next_attempt_at: null,
        lease: {
          lease_id: `lease-${randomUUID()}`,
          worker_id: this.workerId,
          acquired_at: timestamp,
          renewed_at: timestamp,
          expires_at: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
        },
        latest_checkpoint: { stage: "claimed", recorded_at: timestamp },
      };
      this.store.writeJob(next);
      this.event(next.job_id, "job.claimed", `attempt=${next.attempt_count}`);
      return next;
    });
  }

  private complete(claimed: ShadowJob, summary: string): ShadowTickResult {
    return this.store.withLock(() => {
      const current = this.store.readJob(claimed.job_id);
      if (!current || current.status !== "leased" || current.lease?.lease_id !== claimed.lease?.lease_id) {
        return { action: "idle" };
      }
      const timestamp = this.now().toISOString();
      const next: ShadowJob = {
        ...current,
        status: "completed",
        updated_at: timestamp,
        completed_at: timestamp,
        lease: null,
        latest_checkpoint: { stage: "shadow-verified", recorded_at: timestamp, detail: bounded(summary, 500) },
        last_error: null,
        result: { shadow_verified: true, summary: bounded(summary, 500) },
      };
      this.store.writeJob(next);
      this.event(next.job_id, "job.shadow_verified");
      return { action: "completed", job_id: next.job_id };
    });
  }

  private fail(claimed: ShadowJob, error: unknown): ShadowTickResult {
    return this.store.withLock(() => {
      const current = this.store.readJob(claimed.job_id);
      if (!current || current.status !== "leased" || current.lease?.lease_id !== claimed.lease?.lease_id) {
        return { action: "idle" };
      }
      const now = this.now();
      const message = bounded(error instanceof Error ? error.message : String(error), 500);
      const exhausted = current.attempt_count >= current.max_attempts;
      const next = exhausted ? this.toDeadLetter(current, now, message) : this.toRetry(current, now, message);
      this.store.writeJob(next);
      this.event(next.job_id, exhausted ? "job.dead_lettered" : "job.retry_scheduled", message);
      return { action: exhausted ? "dead_lettered" : "retry_scheduled", job_id: next.job_id };
    });
  }

  private toRetry(job: ShadowJob, now: Date, message: string): ShadowJob {
    const delayMs = this.retryBaseMs * 2 ** Math.max(0, job.attempt_count - 1);
    return {
      ...job,
      status: "retry_wait",
      updated_at: now.toISOString(),
      next_attempt_at: new Date(now.getTime() + delayMs).toISOString(),
      lease: null,
      latest_checkpoint: { stage: "retry", recorded_at: now.toISOString(), detail: message },
      last_error: message,
    };
  }

  private toDeadLetter(job: ShadowJob, now: Date, message: string): ShadowJob {
    return {
      ...job,
      status: "dead_letter",
      updated_at: now.toISOString(),
      next_attempt_at: null,
      lease: null,
      latest_checkpoint: { stage: "terminal", recorded_at: now.toISOString(), detail: message },
      last_error: message,
    };
  }

  private event(jobId: string, type: ShadowEventType, detail?: string): void {
    this.store.appendEvent({
      event_id: `event-${randomUUID()}`,
      job_id: jobId,
      type,
      recorded_at: this.now().toISOString(),
      ...(detail ? { detail: bounded(detail, 500) } : {}),
    });
  }
}

export class NoSideEffectShadowExecutor implements ShadowExecutor {
  async run(job: ShadowJob): Promise<{ summary: string }> {
    if (job.mode !== "shadow") throw new Error("control plane refuses non-shadow execution");
    return { summary: "sanitized assignment metadata verified; no production action executed" };
  }
}

function validateInput(raw: unknown): ShadowJobInput {
  if (!isRecord(raw)) throw new Error("request body must be an object");
  rejectUnknown(raw, ["idempotency_key", "source", "metadata"]);
  const idempotencyKey = requiredString(raw.idempotency_key, "idempotency_key", 200);
  if (!isRecord(raw.source)) throw new Error("source must be an object");
  rejectUnknown(raw.source, ["assignment_id", "campaign_id", "task_id"]);
  const source = {
    assignment_id: requiredString(raw.source.assignment_id, "source.assignment_id", 200),
    campaign_id: requiredString(raw.source.campaign_id, "source.campaign_id", 200),
    task_id: requiredString(raw.source.task_id, "source.task_id", 200),
  };
  let metadata: ShadowJobMetadata | undefined;
  if (raw.metadata !== undefined) {
    if (!isRecord(raw.metadata)) throw new Error("metadata must be an object");
    rejectUnknown(raw.metadata, ["identifier", "name", "target_repository", "attempt"]);
    metadata = {};
    for (const key of ["identifier", "name", "target_repository"] as const) {
      if (raw.metadata[key] !== undefined) metadata[key] = requiredString(raw.metadata[key], `metadata.${key}`, 300);
    }
    if (raw.metadata.attempt !== undefined) {
      if (!Number.isInteger(raw.metadata.attempt) || Number(raw.metadata.attempt) < 0) throw new Error("metadata.attempt must be a non-negative integer");
      metadata.attempt = Number(raw.metadata.attempt);
    }
  }
  return { idempotency_key: idempotencyKey, source, ...(metadata ? { metadata } : {}) };
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`unsupported fields: ${unknown.sort().join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  return trimmed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function bounded(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
