#!/usr/bin/env bun
/**
 * Build Watchdog — deterministic progress-state evaluation for long-running builds.
 *
 * The script parses one canonical markdown progress file, compares it with the
 * last acknowledged snapshot, and emits a JSON verdict only. Callers decide how to
 * deliver material events. `--dry-run` guarantees that no state file is written.
 *
 * Progress files use GFM task lists plus structured `status`, `watchdog`, and
 * `BLOCKED:` declarations. A missing progress file degrades to a one-shot verdict.
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
  --dry-run           Compute the verdict without writing or updating state.
  --json              Print the full JSON verdict (default behavior anyway).
  --reset             Re-baseline: record current state silently, clear stall flag.
  --help              Show this help.

VERDICT (stdout JSON)
  { notify: bool, reason: COMPLETE|MILESTONE|BLOCKER|RECOVERY|SCOPE|REGRESSION|STALL|BASELINE|MISSING|OPTED_OUT|SILENT,
    message: string, done: n, total: n, complete: bool }

The managed watchdog service consumes this verdict and consolidates material events for delivery.
`;

// ── progress parsing ──────────────────────────────────────────────────────────
export interface Parsed {
  items: { text: string; done: boolean }[];
  done: number;
  total: number;
  blockers: string[];
  complete: boolean;
  status: "in_progress" | "blocked" | "complete" | null;
  watchMode: "active" | "off";
}

const STATUS_RE = /^status\s*[:=]\s*(in[\s_-]*progress|blocked|complete)\s*$/i;
const WATCH_RE = /^watchdog\s*[:=]\s*(active|on|off|paused|retired)\s*$/i;
const BLOCKER_RE = /^(?:[-*+]\s*)?(?:\[\s\]\s*)?(?:\*\*)?(?:\[BLOCKED\]\s*|BLOCKED\s*:)/i;

export function parseProgress(text: string): Parsed {
  const lines = text.split(/\r?\n/);
  const items: { text: string; done: boolean }[] = [];
  const blockers: string[] = [];
  let status: Parsed["status"] = null;
  let watchMode: Parsed["watchMode"] = "active";

  for (const raw of lines) {
    const line = raw.trim();
    const box = line.match(/^[-*+>\s]*\[([ xX])\]\s*(.+)$/);
    if (box) {
      const done = box[1].toLowerCase() === "x";
      const label = box[2].replace(/\s+/g, " ").trim();
      items.push({ text: label, done });
    }
    const normalized = line.replace(/^>\s*/, "").replace(/\*\*/g, "").trim();
    const statusMatch = normalized.match(STATUS_RE);
    if (statusMatch) {
      const value = statusMatch[1].toLowerCase().replace(/[\s-]+/g, "_");
      status = value === "complete" ? "complete" : value === "blocked" ? "blocked" : "in_progress";
    }
    const watchMatch = normalized.match(WATCH_RE);
    if (watchMatch) {
      watchMode = /^(active|on)$/i.test(watchMatch[1]) ? "active" : "off";
    }
    if (BLOCKER_RE.test(normalized)) {
      const blocker = normalized
        .replace(/^[-*+]\s*/, "")
        .replace(/^\[\s\]\s*/, "")
        .replace(/^(?:\[BLOCKED\]\s*|BLOCKED\s*:)\s*/i, "")
        .replace(/\s+/g, " ")
        .slice(0, 320);
      blockers.push(blocker);
    }
  }

  const done = items.filter((i) => i.done).length;
  const total = items.length;
  if (status === "blocked" && blockers.length === 0) {
    blockers.push("BLOCKED: progress status is blocked.");
  }
  const complete = status === "complete" || (status !== "in_progress" && total > 0 && done === total);
  return { items, done, total, blockers, complete, status, watchMode };
}

// ── state ──────────────────────────────────────────────────────────────────
export interface State {
  version?: number;
  itemTexts?: string[];
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
  const dryRun = args["dry-run"] === "true";
  const now = Date.now();

  const emit = (v: {
    notify: boolean;
    reason: string;
    message: string;
    done: number;
    total: number;
    complete: boolean;
    retired?: boolean;
    statePath?: string;
    nextState?: State;
  }) => {
    console.log(JSON.stringify({ ...v, dryRun, stateWritesEnabled: !dryRun }, null, 2));
  };
  const persist = (state: State) => {
    if (!dryRun) saveState(statePath, state);
  };

  // Missing progress file → one-shot notify, don't crash.
  if (!existsSync(progressPath)) {
    const prev = loadState(statePath);
    const notify = !prev || !(prev as any).missingNotified;
    const nextState = {
      version: 2,
      itemTexts: [],
      doneTexts: [], done: 0, total: 0, blockers: [], complete: false,
      lastChangeTs: now, stallNotified: false, completeNotified: false,
      ...( { missingNotified: true } as any),
    } as State;
    persist(nextState);
    emit({
      notify,
      reason: "MISSING",
      message: `⚠️ ${label}: progress file not found at ${progressPath}. Watchdog can't track it.`,
      done: 0, total: 0, complete: false, statePath, nextState,
    });
    process.exit(0);
  }

  const cur = parseProgress(readFileSync(progressPath, "utf8"));
  const prev = loadState(statePath);
  const curItemTexts = cur.items.map((i) => i.text);
  const curDoneTexts = cur.items.filter((i) => i.done).map((i) => i.text);

  if (cur.watchMode === "off") {
    emit({
      notify: false,
      reason: "OPTED_OUT",
      message: `${label} is opted out of build-watchdog monitoring.`,
      done: cur.done,
      total: cur.total,
      complete: cur.complete,
      retired: true,
    });
    process.exit(0);
  }

  // --reset or first run → silent baseline.
  if (args.reset || !prev) {
    const nextState: State = {
      version: 2,
      itemTexts: curItemTexts,
      doneTexts: curDoneTexts, done: cur.done, total: cur.total, blockers: cur.blockers,
      complete: cur.complete, lastChangeTs: now, stallNotified: false, completeNotified: cur.complete,
    };
    persist(nextState);
    emit({
      notify: false, reason: "BASELINE",
      message: `Baseline recorded for ${label}: ${cur.done}/${cur.total} done.`,
      done: cur.done, total: cur.total, complete: cur.complete, retired: cur.complete,
      statePath, nextState,
    });
    process.exit(0);
  }

  const newlyDone = curDoneTexts.filter((t) => !prev.doneTexts.includes(t));
  const newBlockers = cur.blockers.filter((b) => !prev.blockers.includes(b));
  const resolvedBlockers = prev.blockers.filter((b) => !cur.blockers.includes(b));
  const hasItemBaseline = Array.isArray(prev.itemTexts);
  const addedItems = hasItemBaseline
    ? curItemTexts.filter((text) => !prev.itemTexts!.includes(text))
    : [];
  const removedItems = hasItemBaseline
    ? prev.itemTexts!.filter((text) => !curItemTexts.includes(text))
    : [];
  const scopeChanged = addedItems.length > 0 || removedItems.length > 0;
  const changed =
    cur.done !== prev.done || cur.complete !== prev.complete ||
    newlyDone.length > 0 || newBlockers.length > 0 ||
    resolvedBlockers.length > 0 || scopeChanged;
  const lastChangeTs = changed ? now : prev.lastChangeTs;

  let notify = false;
  let reason = "SILENT";
  let message = "";
  let stallNotified = changed ? false : prev.stallNotified;
  let completeNotified = cur.complete ? prev.completeNotified : false;

  if (cur.complete && !prev.completeNotified) {
    notify = true; reason = "COMPLETE"; completeNotified = true;
    message = `✅ ${label} complete — ${cur.done}/${cur.total} done. The watchdog can be retired.`;
  } else if (newBlockers.length > 0) {
    notify = true; reason = "BLOCKER";
    message = `⚠️ ${label} hit a blocker: ${newBlockers[0]} (${cur.done}/${cur.total} done).`;
  } else if (resolvedBlockers.length > 0) {
    notify = true; reason = "RECOVERY";
    message = `${label} cleared ${resolvedBlockers.length} blocker${resolvedBlockers.length === 1 ? "" : "s"} — ${cur.done}/${cur.total} done.`;
  } else if (prev.complete && !cur.complete) {
    notify = true; reason = "REGRESSION";
    message = `${label} reopened after completion — now ${cur.done}/${cur.total} done.`;
  } else if (scopeChanged) {
    notify = true; reason = "SCOPE";
    message = `${label} scope changed — ${addedItems.length} added, ${removedItems.length} removed; ${cur.done}/${cur.total} done.`;
  } else if (cur.done > prev.done) {
    notify = true; reason = "MILESTONE";
    const latest = newlyDone.length ? ` Latest: ${newlyDone[newlyDone.length - 1]}.` : "";
    message = `${label}: ${cur.done}/${cur.total} done (+${cur.done - prev.done}).${latest}`;
  } else if (cur.done < prev.done) {
    notify = true; reason = "REGRESSION";
    message = `${label}: a step reverted — now ${cur.done}/${cur.total} done.`;
  } else if (
    stallMin > 0 && !cur.complete && cur.blockers.length === 0 && cur.done > 0 &&
    now - lastChangeTs > stallMin * 60_000 && !prev.stallNotified
  ) {
    notify = true; reason = "STALL"; stallNotified = true;
    const mins = Math.round((now - lastChangeTs) / 60_000);
    message = `⏳ ${label} may be stalled — no progress for ${mins} min at ${cur.done}/${cur.total}.`;
  }

  const nextState: State = {
    version: 2,
    itemTexts: curItemTexts,
    doneTexts: curDoneTexts, done: cur.done, total: cur.total, blockers: cur.blockers,
    complete: cur.complete, lastChangeTs, stallNotified, completeNotified,
  };
  persist(nextState);
  emit({
    notify,
    reason,
    message,
    done: cur.done,
    total: cur.total,
    complete: cur.complete,
    retired: cur.complete && completeNotified,
    statePath,
    nextState,
  });
  process.exit(0);
}

if (import.meta.main) main();
