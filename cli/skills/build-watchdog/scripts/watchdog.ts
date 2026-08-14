#!/usr/bin/env bun
/**
 * Build Watchdog — a change-gated progress monitor for long-running builds.
 *
 * The naive way to "check in on a long job" is a dumb clock: text every N minutes
 * regardless of whether anything happened. That is noisy and costs a full chat
 * session on every fire. This script is the smart gate instead: it reads ONE
 * canonical progress file, diffs it against the last-seen state, and only emits a
 * NOTIFY verdict when something material changed — a milestone completed, a blocker
 * appeared, the whole build finished, or the build went quiet long enough to look
 * stalled. Otherwise it stays SILENT.
 *
 * It performs no side effects of its own: it prints a JSON verdict to stdout and the
 * calling scheduled agent decides whether to send the SMS (verdict.notify) using
 * verdict.message. The agent stays a thin trigger; this script holds the judgment.
 *
 * Progress file format: any markdown with GFM task lists. `- [x]` counts as done,
 * `- [ ]` as pending. Lines containing BLOCKED / ERROR / FAILED / ❌ are treated as
 * blockers. An explicit "status: complete" / "✅ complete" line, or all-boxes-checked,
 * marks the build complete.
 *
 * Exit codes: 0 = ran (check verdict.notify), 1 = bad usage / unreadable args.
 * A missing progress file is NOT a crash — it degrades to a one-shot "missing" notify.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, basename } from "path";

// ── args ────────────────────────────────────────────────────────────────────
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

const HELP = `build-watchdog — change-gated progress monitor for long-running builds

USAGE
  bun watchdog.ts --progress <path> [options]

OPTIONS
  --progress <path>   Canonical progress file to watch (markdown task list). Required.
  --state <path>      State file for last-seen snapshot. Default: <progress-dir>/.watchdog-state.json
  --label <name>      Human label used in messages. Default: progress file's parent dir name.
  --stall-min <n>     Minutes of no change before a STALL notify. Default: 45. Set 0 to disable.
  --json              Print the full JSON verdict (default behavior anyway).
  --reset             Re-baseline: record current state silently, clear stall flag.
  --help              Show this help.

VERDICT (stdout JSON)
  { notify: bool, reason: COMPLETE|MILESTONE|BLOCKER|REGRESSION|STALL|BASELINE|MISSING|SILENT,
    message: string, done: n, total: n, complete: bool }

The scheduled agent runs this, and IF verdict.notify is true, sends verdict.message via SMS.
`;

// ── progress parsing ──────────────────────────────────────────────────────────
interface Parsed {
  items: { text: string; done: boolean }[];
  done: number;
  total: number;
  blockers: string[];
  complete: boolean;
}

const BLOCKER_RE = /\b(BLOCKED|ERROR|FAILED|FAILURE|FATAL)\b|❌/i;
const COMPLETE_RE = /(^|\s)(status\s*[:=]\s*complete|✅\s*complete|build\s+complete|all\s+(done|complete))/i;

function parseProgress(text: string): Parsed {
  const lines = text.split(/\r?\n/);
  const items: { text: string; done: boolean }[] = [];
  const blockers: string[] = [];
  let explicitComplete = false;

  for (const raw of lines) {
    const line = raw.trim();
    const box = line.match(/^[-*+>\s]*\[([ xX])\]\s*(.+)$/);
    if (box) {
      const done = box[1].toLowerCase() === "x";
      const label = box[2].replace(/\s+/g, " ").trim();
      items.push({ text: label, done });
    }
    if (BLOCKER_RE.test(line)) blockers.push(line.replace(/\s+/g, " ").slice(0, 160));
    if (COMPLETE_RE.test(line)) explicitComplete = true;
  }

  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const complete = explicitComplete || (total > 0 && done === total);
  return { items, done, total, blockers, complete };
}

// ── state ──────────────────────────────────────────────────────────────────
interface State {
  doneTexts: string[];
  done: number;
  total: number;
  blockers: string[];
  complete: boolean;
  lastChangeTs: number;
  stallNotified: boolean;
  completeNotified: boolean;
}

function loadState(path: string): State | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {
    return null;
  }
}

function saveState(path: string, s: State) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2));
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const progressPath = args.progress;
  if (!progressPath) {
    console.error("error: --progress <path> is required. See --help.");
    process.exit(1);
  }
  const label = args.label || basename(dirname(progressPath)) || "build";
  const statePath = args.state || join(dirname(progressPath), ".watchdog-state.json");
  const stallMin = args["stall-min"] !== undefined ? Number(args["stall-min"]) : 45;
  const now = Date.now();

  const emit = (v: { notify: boolean; reason: string; message: string; done: number; total: number; complete: boolean }) => {
    console.log(JSON.stringify(v, null, 2));
  };

  // Missing progress file → one-shot notify, don't crash.
  if (!existsSync(progressPath)) {
    const prev = loadState(statePath);
    const notify = !prev || !(prev as any).missingNotified;
    saveState(statePath, {
      doneTexts: [], done: 0, total: 0, blockers: [], complete: false,
      lastChangeTs: now, stallNotified: false, completeNotified: false,
      ...( { missingNotified: true } as any),
    } as State);
    emit({
      notify,
      reason: "MISSING",
      message: `⚠️ ${label}: progress file not found at ${progressPath}. Watchdog can't track it.`,
      done: 0, total: 0, complete: false,
    });
    process.exit(0);
  }

  const cur = parseProgress(readFileSync(progressPath, "utf8"));
  const prev = loadState(statePath);
  const curDoneTexts = cur.items.filter((i) => i.done).map((i) => i.text);

  // --reset or first run → silent baseline.
  if (args.reset || !prev) {
    saveState(statePath, {
      doneTexts: curDoneTexts, done: cur.done, total: cur.total, blockers: cur.blockers,
      complete: cur.complete, lastChangeTs: now, stallNotified: false, completeNotified: cur.complete,
    });
    emit({
      notify: false, reason: "BASELINE",
      message: `Baseline recorded for ${label}: ${cur.done}/${cur.total} done.`,
      done: cur.done, total: cur.total, complete: cur.complete,
    });
    process.exit(0);
  }

  const newlyDone = curDoneTexts.filter((t) => !prev.doneTexts.includes(t));
  const newBlockers = cur.blockers.filter((b) => !prev.blockers.includes(b));
  const changed =
    cur.done !== prev.done || cur.complete !== prev.complete ||
    newlyDone.length > 0 || newBlockers.length > 0;
  const lastChangeTs = changed ? now : prev.lastChangeTs;

  let notify = false;
  let reason = "SILENT";
  let message = "";
  let stallNotified = changed ? false : prev.stallNotified;
  let completeNotified = prev.completeNotified;

  if (cur.complete && !prev.completeNotified) {
    notify = true; reason = "COMPLETE"; completeNotified = true;
    message = `✅ ${label} complete — ${cur.done}/${cur.total} done. The watchdog can be retired.`;
  } else if (newBlockers.length > 0) {
    notify = true; reason = "BLOCKER";
    message = `⚠️ ${label} hit a blocker: ${newBlockers[0]} (${cur.done}/${cur.total} done).`;
  } else if (cur.done > prev.done) {
    notify = true; reason = "MILESTONE";
    const latest = newlyDone.length ? ` Latest: ${newlyDone[newlyDone.length - 1]}.` : "";
    message = `${label}: ${cur.done}/${cur.total} done (+${cur.done - prev.done}).${latest}`;
  } else if (cur.done < prev.done) {
    notify = true; reason = "REGRESSION";
    message = `${label}: a step reverted — now ${cur.done}/${cur.total} done.`;
  } else if (
    stallMin > 0 && !cur.complete && cur.done > 0 &&
    now - lastChangeTs > stallMin * 60_000 && !prev.stallNotified
  ) {
    notify = true; reason = "STALL"; stallNotified = true;
    const mins = Math.round((now - lastChangeTs) / 60_000);
    message = `⏳ ${label} may be stalled — no progress for ${mins} min at ${cur.done}/${cur.total}.`;
  }

  saveState(statePath, {
    doneTexts: curDoneTexts, done: cur.done, total: cur.total, blockers: cur.blockers,
    complete: cur.complete, lastChangeTs, stallNotified, completeNotified,
  });
  emit({ notify, reason, message, done: cur.done, total: cur.total, complete: cur.complete });
  process.exit(0);
}

main();
