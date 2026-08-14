#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import { createControlPlaneApi } from "../src/control-plane/api";
import { ShadowCoordinator } from "../src/control-plane/coordinator";
import { ControlPlaneStore } from "../src/control-plane/store";

const root = `/tmp/hetzner-control-plane-smoke-${process.pid}`;
mkdirSync(root, { recursive: true });
const token = "smoke-token";
const coordinator = new ShadowCoordinator(new ControlPlaneStore(root));
const api = createControlPlaneApi(coordinator, { authToken: token, host: "127.0.0.1", port: 0 });

try {
  await api.listen();
  const base = `http://127.0.0.1:${api.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const created = await fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      idempotency_key: "smoke-assignment",
      source: { assignment_id: "smoke-assignment", campaign_id: "smoke-campaign", task_id: "smoke-task" },
    }),
  });
  if (created.status !== 201) throw new Error(`submit failed: HTTP ${created.status}`);
  const createdBody = await created.json() as { job: { job_id: string } };
  const tick = await fetch(`${base}/v1/tick`, { method: "POST", headers });
  const tickBody = await tick.json() as { action?: string };
  if (tick.status !== 200 || tickBody.action !== "completed") throw new Error("tick did not complete the shadow job");
  const job = await fetch(`${base}/v1/jobs/${createdBody.job.job_id}`, { headers });
  const jobBody = await job.json() as { job?: { status?: string; mode?: string } };
  if (jobBody.job?.status !== "completed" || jobBody.job.mode !== "shadow") throw new Error("job did not persist a shadow completion");
  console.log(JSON.stringify({ ok: true, job_id: createdBody.job.job_id, action: tickBody.action }));
} finally {
  await api.close();
  rmSync(root, { recursive: true, force: true });
}
