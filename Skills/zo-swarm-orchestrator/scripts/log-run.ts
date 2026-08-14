#!/usr/bin/env bun
/**
 * log-run.ts — Manually log a formal swarm run to /root/.swarm/results/
 *
 * Usage:
 *   bun log-run.ts "ACAP site review audit" --tasks 12 --success 11 --failed 1
 *   bun log-run.ts "Memory decay pipeline" --tasks 5
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const RESULTS_DIR = "/root/.swarm/results";

function usage() {
  console.log(`
Usage: bun log-run.ts <description> [options]

Options:
  --tasks <n>       Total task count (default: 1)
  --success <n>     Successful tasks (default: same as --tasks)
  --failed <n>      Failed tasks (default: 0)
  --duration <ms>   Duration in ms (default: 0)
  --tokens <n>      Estimated tokens (default: 0)
  --swarm-id <id>   Custom swarm ID prefix (default: manual)
  --date <iso>      Override timestamp (default: now)

Example:
  bun log-run.ts "ACAP site review audit" --tasks 12 --success 11 --failed 1
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") { usage(); process.exit(0); }

const description = args[0];
const get = (flag: string, def: string | null = null) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const totalTasks  = parseInt(get("--tasks",    "1")!);
const failed      = parseInt(get("--failed",   "0")!);
const successful  = parseInt(get("--success",  String(totalTasks - failed))!);
const durationMs  = parseInt(get("--duration", "0")!);
const tokens      = parseInt(get("--tokens",   "0")!);
const swarmPrefix = get("--swarm-id", "manual");
const dateStr     = get("--date", new Date().toISOString());

const ts    = new Date(dateStr!).getTime();
const swarmId = `${swarmPrefix}-${description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${ts}`;
const filename  = `${swarmId}.json`;

const payload = {
  swarmId,
  timestamp: new Date(dateStr!).toISOString(),
  sessionId: `manual-${ts}`,
  source: "manual",
  description,
  config: { maxConcurrency: 1, manual: true },
  results: [],
  summary: {
    total: totalTasks,
    successful,
    failed,
    totalDurationMs: durationMs,
    totalTokensEstimated: tokens
  }
};

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = join(RESULTS_DIR, filename);
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`✅ Logged: ${outPath}`);
console.log(`   Swarm: ${swarmId}`);
console.log(`   Tasks: ${totalTasks} total, ${successful} success, ${failed} failed`);
