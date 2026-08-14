#!/usr/bin/env bun
/**
 * Build Watchdog Sweep — auto-discovery layer for the watchdog.
 *
 * The per-build watchdog (watchdog.ts) needs to be pointed at a specific progress file.
 * This sweep removes that manual step: it globs for PROGRESS.md files under the project
 * roots, keeps only the ones that look like an ACTIVE build (modified within --fresh-hours),
 * and runs the watchdog against each. So a long-running session that drops a PROGRESS.md is
 * picked up automatically — nobody has to "stand up" a watcher — and a finished or abandoned
 * build falls off the sweep on its own once the file stops changing.
 *
 * It reuses watchdog.ts verbatim (shells out per file) so the verdict logic has one home.
 * It prints a combined JSON manifest; the calling agent sends an SMS for each notification.
 *
 * No side effects beyond per-build .watchdog-state.json files (same as watchdog.ts).
 */

import { Glob } from "bun";
import { statSync } from "fs";
import { join, dirname, basename } from "path";

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
  --root <dir>         Base dir to scan. Default: $ZOUROBOROS_WORKSPACE, $ZO_WORKSPACE, or cwd.
  --patterns <globs>   Comma-separated globs (relative to --root) for progress files.
                       Default: Projects/*/PROGRESS.md,Projects/*/*/PROGRESS.md
  --fresh-hours <n>    Only watch files modified within this many hours (an "active" build).
                       Default: 24. Set 0 to watch regardless of age.
  --stall-min <n>      Passed through to watchdog.ts. Default: 45.
  --help               Show this help.

OUTPUT (stdout JSON)
  { checked: n, active: [paths], notifications: [{ label, reason, message }], ts }

The scheduled agent runs this and sends an SMS for EACH entry in notifications.
A run with notifications: [] means nothing needs the operator — send nothing.
`;

const WATCHDOG = join(import.meta.dir, "watchdog.ts");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const root = args.root || process.env.ZOUROBOROS_WORKSPACE || process.env.ZO_WORKSPACE || process.cwd();
  const patterns = (args.patterns || "Projects/*/PROGRESS.md,Projects/*/*/PROGRESS.md")
    .split(",").map((p) => p.trim()).filter(Boolean);
  const freshHours = args["fresh-hours"] !== undefined ? Number(args["fresh-hours"]) : 24;
  const stallMin = args["stall-min"] !== undefined ? String(args["stall-min"]) : "45";
  const now = Date.now();

  // Discover candidate progress files.
  const found = new Set<string>();
  for (const pat of patterns) {
    const glob = new Glob(pat);
    for await (const rel of glob.scan({ cwd: root, absolute: true })) found.add(rel);
  }

  // Keep only "active" (recently modified) files.
  const active: string[] = [];
  for (const path of found) {
    try {
      const mtime = statSync(path).mtimeMs;
      if (freshHours <= 0 || now - mtime <= freshHours * 3_600_000) active.push(path);
    } catch { /* vanished mid-sweep */ }
  }

  const notifications: { label: string; reason: string; message: string }[] = [];
  for (const path of active) {
    const label = `${basename(dirname(path))} build`;
    const proc = Bun.spawnSync([
      "bun", WATCHDOG, "--progress", path, "--label", label, "--stall-min", stallMin,
    ]);
    let verdict: any;
    try { verdict = JSON.parse(proc.stdout.toString()); } catch { continue; }
    if (verdict?.notify) {
      notifications.push({ label, reason: verdict.reason, message: verdict.message });
    }
  }

  console.log(JSON.stringify({
    checked: found.size, active, notifications, ts: new Date(now).toISOString(),
  }, null, 2));
  process.exit(0);
}

main();
