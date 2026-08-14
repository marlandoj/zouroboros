import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ShadowJobInput } from "./types";

export interface FactoryAssignmentLike {
  assignment_id: string;
  campaign_id: string;
  task_id: string;
  attempt?: number;
  target_repository?: string;
  identifier?: string;
  name?: string;
}

export interface ShadowAdapterOptions {
  baseUrl: string;
  authToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function sanitizeFactoryAssignment(raw: unknown): ShadowJobInput {
  if (!isRecord(raw)) throw new Error("assignment must be an object");
  const assignmentId = requiredString(raw.assignment_id, "assignment_id");
  const campaignId = requiredString(raw.campaign_id, "campaign_id");
  const taskId = requiredString(raw.task_id, "task_id");
  const metadata: ShadowJobInput["metadata"] = {};
  for (const key of ["identifier", "name", "target_repository"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) metadata[key] = value.trim().slice(0, 300);
  }
  if (Number.isInteger(raw.attempt) && Number(raw.attempt) >= 0) metadata.attempt = Number(raw.attempt);
  return {
    idempotency_key: `factory-assignment:${assignmentId}`,
    source: { assignment_id: assignmentId, campaign_id: campaignId, task_id: taskId },
    metadata,
  };
}

export async function mirrorFactoryAssignment(
  assignment: unknown,
  options: ShadowAdapterOptions,
): Promise<{ job_id: string; deduplicated: boolean }> {
  if (!options.authToken) throw new Error("shadow adapter auth token is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}/v1/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.authToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(sanitizeFactoryAssignment(assignment)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`shadow mirror rejected with HTTP ${response.status}`);
    const body = await response.json() as { job?: { job_id?: unknown }; deduplicated?: unknown };
    if (typeof body.job?.job_id !== "string") throw new Error("shadow mirror returned an invalid response");
    return { job_id: body.job.job_id, deduplicated: body.deduplicated === true };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncAssignmentDirectory(
  directory: string,
  options: ShadowAdapterOptions,
): Promise<{ mirrored: number; deduplicated: number; failed: number }> {
  const result = { mirrored: 0, deduplicated: 0, failed: 0 };
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const assignment = JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
      const mirrored = await mirrorFactoryAssignment(assignment, options);
      if (mirrored.deduplicated) result.deduplicated++;
      else result.mirrored++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value.trim().slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
