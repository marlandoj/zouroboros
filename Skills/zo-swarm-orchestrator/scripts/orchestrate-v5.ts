#!/usr/bin/env bun
/**
 * Deprecated compatibility wrapper.
 *
 * The canonical orchestrator runtime lives in:
 *   /home/workspace/zouroboros/packages/swarm/scripts/orchestrate-v5.ts
 *
 * This wrapper preserves the legacy skill entrypoint while delegating all
 * behavior to the maintained package surface.
 */

import { spawn } from "child_process";

const CANONICAL_SCRIPT = "/home/workspace/zouroboros/packages/swarm/scripts/orchestrate-v5.ts";

const proc = spawn("bun", [CANONICAL_SCRIPT, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

proc.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

proc.on("error", (error) => {
  console.error(`Failed to launch canonical orchestrator: ${error.message}`);
  process.exit(1);
});
