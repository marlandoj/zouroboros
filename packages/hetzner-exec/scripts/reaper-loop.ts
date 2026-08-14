#!/usr/bin/env bun

import { reapExpiredWorkers } from "../src/ephemeral-worker";

const intervalMs = Math.max(60_000, Number(process.env.HETZNER_WORKER_REAPER_INTERVAL_MS ?? 300_000));
let firstSweep = true;

async function sweep(): Promise<void> {
  try {
    const result = await reapExpiredWorkers();
    if (firstSweep || result.deleted.length > 0 || result.ssh_keys_deleted.length > 0) {
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    }
    firstSweep = false;
  } catch (error) {
    console.error(`[hetzner-worker-reaper] ${error instanceof Error ? error.message : String(error)}`);
  }
}

await sweep();
setInterval(() => void sweep(), intervalMs);
