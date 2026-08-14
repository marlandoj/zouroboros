#!/usr/bin/env bun
/**
 * Build Watchdog Sweep — deterministic discovery and digest aggregation.
 *
 * The sweep finds recent PROGRESS.md files, applies explicit monitoring metadata,
 * evaluates each file through watchdog.ts, and returns one severity-grouped digest.
 * `--dry-run` passes through to every watcher and performs no state writes.
 */

import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { parseProgress } from "./watchdog";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = "true";
  }
  return out;
}

const HELP = `build-watchdog sweep — auto-discover and watch active builds

USAGE
  bun watchdog-sweep.ts [options]

OPTIONS
  --root <dir>         Base dir to scan. Default: /home/workspace
  --patterns <globs>   Comma-separated globs (relative to --root) for progress files.
                       Default: Projects/*/PROGRESS.md,Projects/*/*/PROGRESS.md
  --fresh-hours <n>    Only watch files modified within this many hours (an "active" build).
                       Default: 24. Set 0 to watch regardless of age.
  --stall-min <n>      Passed through to watchdog.ts. Default: 45.
  --dry-run            Compute all verdicts without mutating per-project state.
  --help               Show this help.

OUTPUT (stdout JSON)
  { checked, active, retired, optedOut, notifications, digest, dryRun, ts }

The managed watchdog service delivers the consolidated digest when it is non-null.
A run with notifications: [] requires no delivery or model call.
`;

const WATCHDOG = join(import.meta.dir, "watchdog.ts");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const root = args.root || "/home/workspace";
  const patterns = (args.patterns || "Projects/*/PROGRESS.md,Projects/*/*/PROGRESS.md")
    .split(",").map((p) => p.trim()).filter(Boolean);
  const freshHours = args["fresh-hours"] !== undefined ? Number(args["fresh-hours"]) : 24;
  const stallMin = args["stall-min"] !== undefined ? String(args["stall-min"]) : "45";
  const dryRun = args["dry-run"] === "true";
  const now = Date.now();

  // Discover candidate progress files.
  const found = new Set<string>();
  for (const pat of patterns) {
    const glob = new Glob(pat);
    for await (const rel of glob.scan({ cwd: root, absolute: true })) found.add(rel);
  }

  // Keep only "active" (recently modified) files.
  const fresh: string[] = [];
  for (const path of found) {
    try {
      const mtime = statSync(path).mtimeMs;
      if (freshHours <= 0 || now - mtime <= freshHours * 3_600_000) fresh.push(path);
    } catch { /* vanished mid-sweep */ }
  }

  const active: string[] = [];
  const retired: string[] = [];
  const optedOut: string[] = [];
  const notifications: { path: string; label: string; reason: string; message: string }[] = [];
  const acknowledgements: { statePath: string; state: Record<string, unknown> }[] = [];
  for (const path of fresh) {
    const parsed = parseProgress(readFileSync(path, "utf8"));
    if (parsed.watchMode === "off") {
      optedOut.push(path);
      continue;
    }
    const statePath = join(dirname(path), ".watchdog-state.json");
    if (parsed.complete && existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.completeNotified === true) {
          retired.push(path);
          continue;
        }
      } catch {
        // The watchdog will re-baseline unreadable state safely.
      }
    }
    active.push(path);
    const label = `${basename(dirname(path))} build`;
    const command = [
      "bun", WATCHDOG, "--progress", path, "--label", label, "--stall-min", stallMin,
    ];
    if (dryRun) command.push("--dry-run");
    const proc = Bun.spawnSync(command);
    let verdict: any;
    try { verdict = JSON.parse(proc.stdout.toString()); } catch { continue; }
    if (verdict?.statePath && verdict?.nextState) {
      acknowledgements.push({ statePath: verdict.statePath, state: verdict.nextState });
    }
    if (verdict?.notify) {
      notifications.push({ path, label, reason: verdict.reason, message: verdict.message });
    }
  }

  const attentionReasons = new Set(["BLOCKER", "REGRESSION", "MISSING", "STALL"]);
  const attention = notifications.filter((entry) => attentionReasons.has(entry.reason));
  const progress = notifications.filter(
    (entry) => !attentionReasons.has(entry.reason) && entry.reason !== "COMPLETE",
  );
  const complete = notifications.filter((entry) => entry.reason === "COMPLETE");
  const digest = notifications.length === 0
    ? null
    : {
        severity: attention.length > 0 ? "attention" : progress.length > 0 ? "progress" : "complete",
        subject: `[Build Watchdog] ${attention.length > 0 ? "Attention" : "Progress"} — ${notifications.length} update${notifications.length === 1 ? "" : "s"}`,
        message: [
          ...attention.map((entry) => `[${entry.reason}] ${entry.message} (progress: ${entry.path})`),
          ...progress.map((entry) => `[${entry.reason}] ${entry.message} (progress: ${entry.path})`),
          ...complete.map((entry) => `[${entry.reason}] ${entry.message} (progress: ${entry.path})`),
        ].join("\n"),
        counts: { attention: attention.length, progress: progress.length, complete: complete.length },
      };

  console.log(JSON.stringify({
    checked: found.size,
    active,
    retired,
    optedOut,
    notifications,
    acknowledgements,
    digest,
    dryRun,
    ts: new Date(now).toISOString(),
  }, null, 2));
  process.exit(0);
}

main();
