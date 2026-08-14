#!/usr/bin/env bun

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SWEEP = `${import.meta.dir}/watchdog-sweep.ts`;
const MODEL = process.env.WATCHDOG_MODEL || "byok:463350ac-4a49-4ceb-8653-042ecffa513f";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals >= 0) args[arg.slice(2, equals)] = arg.slice(equals + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) args[arg.slice(2)] = argv[++index];
    else args[arg.slice(2)] = "true";
  }
  return args;
}

function runSweep(dryRun: boolean) {
  const command = [
    "bun",
    SWEEP,
    "--fresh-hours",
    "24",
    "--stall-min",
    "45",
  ];
  if (dryRun) command.push("--dry-run");
  const result = Bun.spawnSync(command);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `watchdog sweep exited ${result.exitCode}`);
  }
  return JSON.parse(result.stdout.toString());
}

export function commitAcknowledgements(
  acknowledgements: { statePath: string; state: Record<string, unknown> }[],
) {
  for (const acknowledgement of acknowledgements) {
    mkdirSync(dirname(acknowledgement.statePath), { recursive: true });
    const temporaryPath = `${acknowledgement.statePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, JSON.stringify(acknowledgement.state, null, 2));
    renameSync(temporaryPath, acknowledgement.statePath);
  }
}

async function deliverDigest(digest: { subject: string; message: string }) {
  const identityToken = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  const apiKey = process.env.ZO_API_KEY;
  if (!identityToken && !apiKey) {
    throw new Error("ZO_CLIENT_IDENTITY_TOKEN or ZO_API_KEY is required for alert delivery");
  }
  const authorization = identityToken ?? `Bearer ${apiKey}`;
  const input = `You are the build-watchdog delivery agent for the Zouroboros software factory. Send exactly one operational status email to the account owner using send_email_to_user. Do not generate or attach a PDF and do not add additional recipients.

Raw watchdog digest (the trigger for this email):
${digest.message}

Before sending, run a bounded READ-ONLY investigation (no writes, no state changes, no factory commands that mutate anything):
1. Read each PROGRESS.md path referenced in the digest lines above.
2. Read the factory execution state at /home/workspace/.runtime/factory-state/v1: count exec-*.json records with completed_at=null and status "executing" (active builds), hold-*.json with released_at=null (held), and any recent records with status "failed".
3. If a digest line reports a BLOCKER, STALL, REGRESSION, or MISSING, look at the referenced PROGRESS.md's blocker lines and recent content to diagnose why.

Then compose the email body in markdown with exactly these sections, in this order:

## Factory Health
Overall software-factory status in plain language: conveyor functioning or degraded, active/held/failed execution counts, anything abnormal in factory state.

## Build Status
Current status of each ongoing build from the digest and PROGRESS.md files: name, progress (done/total), and what changed.

## Bottom Line
One or two plain sentences: the net situation, and whether the operator needs to act. If nothing needs attention, say so plainly.

## Root Cause & Remediation
For each active issue: the diagnosed root cause paired with concrete recommended remediation steps (exact commands or file paths where possible). If the root cause cannot be determined from the evidence read, state the most probable cause and the single next diagnostic step. Skip this section only if there are no issues.

## Raw Digest
The raw digest lines verbatim.

Subject line: ${digest.subject}

Merely restating the raw errors is not sufficient — the operator expects a diagnosis and actionable insight, not an error dump.`;
  const response = await fetch("https://api.zo.computer/zo/ask", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ input, model_name: MODEL }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Zo alert delivery failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

async function tick(dryRun: boolean) {
  const preview = runSweep(true);
  if (dryRun) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      mode: "dry-run",
      checked: preview.checked,
      active: preview.active.length,
      notifications: preview.notifications.length,
      digest: preview.digest,
    }));
    return;
  }

  if (preview.digest) {
    await deliverDigest(preview.digest);
  }
  commitAcknowledgements(preview.acknowledgements ?? []);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    mode: "commit",
    checked: preview.checked,
    active: preview.active.length,
    retired: preview.retired.length,
    optedOut: preview.optedOut.length,
    notifications: preview.notifications.length,
    acknowledged: preview.acknowledgements?.length ?? 0,
    delivered: Boolean(preview.digest),
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`build-watchdog service

USAGE
  bun watchdog-service.ts [--interval-sec 1800] [--once] [--dry-run]

The service previews the deterministic sweep without mutation, delivers one consolidated
email only when a digest exists, then atomically commits the exact previewed state. Failed
delivery leaves state unchanged so the alert is retried on the next tick.`);
    return;
  }
  const intervalSec = args["interval-sec"] === undefined ? 1800 : Number(args["interval-sec"]);
  if (!Number.isFinite(intervalSec) || intervalSec < 30) {
    throw new Error("--interval-sec must be a number greater than or equal to 30");
  }
  const once = args.once === "true";
  const dryRun = args["dry-run"] === "true";

  while (true) {
    try {
      await tick(dryRun);
    } catch (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    if (once) return;
    await Bun.sleep(intervalSec * 1000);
  }
}

if (import.meta.main) await main();
