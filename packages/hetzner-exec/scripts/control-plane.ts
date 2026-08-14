#!/usr/bin/env bun

import { createControlPlaneRuntimeFromEnv } from "../src/control-plane/runtime";

const runtime = createControlPlaneRuntimeFromEnv();
const address = await runtime.start();
console.log(JSON.stringify({ event: "control-plane.started", mode: "shadow", ...address }));

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "control-plane.stopping", signal }));
  await runtime.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
