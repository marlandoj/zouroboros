#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { mirrorFactoryAssignment, syncAssignmentDirectory } from "../src/control-plane/shadow-adapter";

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.HETZNER_CONTROL_PLANE_URL ?? "";
const authToken = process.env.HETZNER_CONTROL_PLANE_TOKEN ?? "";
if (!baseUrl || !authToken) throw new Error("HETZNER_CONTROL_PLANE_URL and HETZNER_CONTROL_PLANE_TOKEN are required");
const options = { baseUrl, authToken };

if (command === "submit") {
  const path = valueAfter(args, "--file");
  if (!path || !existsSync(path)) usage();
  const result = await mirrorFactoryAssignment(JSON.parse(readFileSync(path, "utf8")) as unknown, options);
  console.log(JSON.stringify(result));
} else if (command === "sync") {
  const directory = valueAfter(args, "--dir");
  if (!directory || !existsSync(directory)) usage();
  const result = await syncAssignmentDirectory(directory, options);
  console.log(JSON.stringify(result));
  if (result.failed > 0) process.exitCode = 1;
} else if (command === "watch") {
  const directory = valueAfter(args, "--dir");
  if (!directory || !existsSync(directory)) usage();
  const pollMs = Number(process.env.HETZNER_CONTROL_PLANE_ADAPTER_POLL_MS ?? "10000");
  if (!Number.isInteger(pollMs) || pollMs <= 0) throw new Error("HETZNER_CONTROL_PLANE_ADAPTER_POLL_MS must be a positive integer");
  let active = false;
  const run = async (): Promise<void> => {
    if (active) return;
    active = true;
    try {
      console.log(JSON.stringify(await syncAssignmentDirectory(directory, options)));
    } finally {
      active = false;
    }
  };
  await run();
  setInterval(() => void run(), pollMs);
} else {
  usage();
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error("Usage: shadow-adapter.ts submit --file <assignment.json> | sync|watch --dir <assignments-dir>");
  process.exit(2);
}
