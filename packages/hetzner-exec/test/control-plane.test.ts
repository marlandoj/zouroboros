import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createControlPlaneApi } from "../src/control-plane/api";
import { ShadowCoordinator, type ShadowExecutor } from "../src/control-plane/coordinator";
import { sanitizeFactoryAssignment } from "../src/control-plane/shadow-adapter";
import { ControlPlaneStore } from "../src/control-plane/store";
import type { ShadowJob } from "../src/control-plane/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; store: ControlPlaneStore } {
  const root = join("/tmp", `hetzner-control-plane-test-${process.pid}-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return { root, store: new ControlPlaneStore(root) };
}

function submission(id = "asg-1"): Record<string, unknown> {
  return {
    idempotency_key: `factory-assignment:${id}`,
    source: { assignment_id: id, campaign_id: "campaign-1", task_id: "task-1" },
    metadata: { identifier: "ZOU-1190", attempt: 0 },
  };
}

describe("shadow coordinator", () => {
  test("persists idempotent intake and append-only events", () => {
    const { root, store } = fixture();
    const coordinator = new ShadowCoordinator(store);
    const first = coordinator.submit(submission());
    const second = coordinator.submit(submission());
    expect(first.deduplicated).toBeFalse();
    expect(second.deduplicated).toBeTrue();
    expect(second.job.job_id).toBe(first.job.job_id);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.readEvents().map((event) => event.type)).toEqual(["job.accepted", "job.deduplicated"]);
    expect(JSON.parse(readFileSync(join(root, "idempotency.json"), "utf8"))["factory-assignment:asg-1"]).toBe(first.job.job_id);
  });

  test("rejects execution-bearing fields and completes only the shadow no-op", async () => {
    const { store } = fixture();
    const coordinator = new ShadowCoordinator(store);
    expect(() => coordinator.submit({ ...submission(), command: "touch /tmp/forbidden" })).toThrow("unsupported fields: command");
    const accepted = coordinator.submit(submission()).job;
    expect(await coordinator.tick()).toEqual({ action: "completed", job_id: accepted.job_id });
    const completed = coordinator.get(accepted.job_id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result?.shadow_verified).toBeTrue();
    expect(completed?.result?.summary).toContain("no production action executed");
  });

  test("retries with bounded backoff and dead-letters after exhaustion", async () => {
    const { store } = fixture();
    let now = new Date("2026-08-07T00:00:00.000Z");
    const failing: ShadowExecutor = { run: async () => { throw new Error("injected transport failure"); } };
    const coordinator = new ShadowCoordinator(store, {
      now: () => now,
      retryBaseMs: 10,
      maxAttempts: 2,
      executor: failing,
    });
    const job = coordinator.submit(submission()).job;
    expect((await coordinator.tick()).action).toBe("retry_scheduled");
    expect(coordinator.get(job.job_id)?.status).toBe("retry_wait");
    now = new Date(now.getTime() + 10);
    expect((await coordinator.tick()).action).toBe("dead_lettered");
    expect(coordinator.get(job.job_id)?.status).toBe("dead_letter");
    expect(coordinator.get(job.job_id)?.attempt_count).toBe(2);
  });

  test("recovers an expired lease after a fresh coordinator starts", async () => {
    const { store } = fixture();
    let now = new Date("2026-08-07T00:00:00.000Z");
    let release: (() => void) | undefined;
    const blocked: ShadowExecutor = {
      run: () => new Promise((resolve) => {
        release = () => resolve({ summary: "late result" });
      }),
    };
    const first = new ShadowCoordinator(store, { now: () => now, leaseTtlMs: 100, retryBaseMs: 10, executor: blocked });
    const job = first.submit(submission()).job;
    const pending = first.tick();
    await waitFor(() => store.readJob(job.job_id)?.status === "leased");
    now = new Date(now.getTime() + 101);
    const restarted = new ShadowCoordinator(store, { now: () => now, leaseTtlMs: 100, retryBaseMs: 10 });
    expect(restarted.reconcile()).toEqual({ recovered: 1, dead_lettered: 0 });
    expect(restarted.get(job.job_id)?.status).toBe("retry_wait");
    release?.();
    expect((await pending).action).toBe("idle");
    now = new Date(now.getTime() + 10);
    expect((await restarted.tick()).action).toBe("completed");
  });

  test("cancellation is terminal and prevents a later tick", async () => {
    const { store } = fixture();
    const coordinator = new ShadowCoordinator(store);
    const job = coordinator.submit(submission()).job;
    expect(coordinator.cancel(job.job_id)?.status).toBe("cancelled");
    expect((await coordinator.tick()).action).toBe("idle");
  });
});

describe("control-plane HTTP API", () => {
  test("authenticates mutations and exposes the full shadow lifecycle", async () => {
    const { store } = fixture();
    const coordinator = new ShadowCoordinator(store);
    const api = createControlPlaneApi(coordinator, { authToken: "test-secret", host: "127.0.0.1", port: 0 });
    await api.listen();
    const base = `http://127.0.0.1:${api.address().port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/v1/jobs`)).status).toBe(401);
      const created = await fetch(`${base}/v1/jobs`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
        body: JSON.stringify(submission("asg-http")),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { job: ShadowJob };
      const ticked = await fetch(`${base}/v1/tick`, { method: "POST", headers: { Authorization: "Bearer test-secret" } });
      expect((await ticked.json() as { action: string }).action).toBe("completed");
      const fetched = await fetch(`${base}/v1/jobs/${createdBody.job.job_id}`, { headers: { Authorization: "Bearer test-secret" } });
      expect((await fetched.json() as { job: ShadowJob }).job.status).toBe("completed");
    } finally {
      await api.close();
    }
  });
});

describe("factory shadow adapter", () => {
  test("emits only allowlisted assignment metadata", () => {
    const sanitized = sanitizeFactoryAssignment({
      assignment_id: "asg-sensitive",
      campaign_id: "campaign-sensitive",
      task_id: "task-sensitive",
      target_repository: "marlandoj/example",
      command: "forbidden",
      prompt: "secret prompt",
      env: { TOKEN: "secret" },
      model: "external-model",
    });
    expect(sanitized).toEqual({
      idempotency_key: "factory-assignment:asg-sensitive",
      source: {
        assignment_id: "asg-sensitive",
        campaign_id: "campaign-sensitive",
        task_id: "task-sensitive",
      },
      metadata: { target_repository: "marlandoj/example" },
    });
    expect(JSON.stringify(sanitized)).not.toContain("forbidden");
    expect(JSON.stringify(sanitized)).not.toContain("secret");
    expect(JSON.stringify(sanitized)).not.toContain("external-model");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}
