#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadManifest,
  reapExpiredWorkers,
  runEphemeralWorker,
} from "../src/ephemeral-worker";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error(`Usage:
  bun scripts/ephemeral-worker.ts run --workdir <path> --manifest <path> --evidence-dir <path>
  bun scripts/ephemeral-worker.ts reap [--dry-run]
`);
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0];

if (command === "run") {
  const workdir = value(args, "--workdir");
  const manifestPath = value(args, "--manifest");
  const evidenceDir = value(args, "--evidence-dir");
  if (!workdir || !manifestPath || !evidenceDir) usage();
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const evidence = await runEphemeralWorker({
    workdir: resolve(workdir),
    manifest: loadManifest(resolve(manifestPath)),
    evidenceDir: resolve(evidenceDir),
  });
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(evidence.status === "passed" && evidence.teardown.server_deleted && evidence.teardown.ssh_key_deleted ? 0 : 1);
}

if (command === "reap") {
  const result = await reapExpiredWorkers({ dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

usage();
