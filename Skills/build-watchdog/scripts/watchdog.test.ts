import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProgress } from "./watchdog";
import { commitAcknowledgements } from "./watchdog-service";

const WATCHDOG = join(import.meta.dir, "watchdog.ts");
const SWEEP = join(import.meta.dir, "watchdog-sweep.ts");
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "build-watchdog-"));
  tempDirs.push(dir);
  return dir;
}

function runWatchdog(progress: string, ...args: string[]) {
  const result = Bun.spawnSync(["bun", WATCHDOG, "--progress", progress, ...args]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

function runSweep(root: string, ...args: string[]) {
  const result = Bun.spawnSync([
    "bun",
    SWEEP,
    "--root",
    root,
    "--patterns",
    "Projects/*/PROGRESS.md",
    "--fresh-hours",
    "0",
    ...args,
  ]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseProgress", () => {
  test("ignores blocker words in prose and completed tasks", () => {
    const parsed = parseProgress(`
- [x] Verify provider failure handling.
- [x] AUTO-LANE BLOCKED below 20 decisions.
- [x] Add auth-failure regression tests.
`);
    expect(parsed.blockers).toEqual([]);
  });

  test("accepts only structured blocker declarations", () => {
    const parsed = parseProgress(`
status: blocked
- [ ] **BLOCKED: reviewer quorum unavailable**
`);
    expect(parsed.blockers).toEqual(["reviewer quorum unavailable"]);
    expect(parsed.status).toBe("blocked");
  });

  test("uses the last canonical status declaration", () => {
    const parsed = parseProgress(`
status: complete
- [x] Historical phase

## Current phase
- [x] Implementation
- [ ] Observe seven daily runs
status: in_progress
`);
    expect(parsed.complete).toBe(false);
    expect(parsed.status).toBe("in_progress");
    expect(parsed.done).toBe(2);
    expect(parsed.total).toBe(3);
  });

  test("supports explicit monitoring opt-out", () => {
    const parsed = parseProgress(`
watchdog: off
status: complete
- [x] Done
`);
    expect(parsed.watchMode).toBe("off");
    expect(parsed.complete).toBe(true);
  });
});

describe("watchdog CLI", () => {
  test("dry-run performs zero state writes", () => {
    const dir = tempDir();
    const progress = join(dir, "PROGRESS.md");
    const state = join(dir, ".watchdog-state.json");
    writeFileSync(progress, "- [x] Started\n- [ ] Finish\nstatus: in_progress\n");

    const verdict = runWatchdog(progress, "--dry-run");

    expect(verdict.reason).toBe("BASELINE");
    expect(verdict.dryRun).toBe(true);
    expect(existsSync(state)).toBe(false);
  });

  test("reports scope changes after a version-two baseline", () => {
    const dir = tempDir();
    const progress = join(dir, "PROGRESS.md");
    const state = join(dir, ".watchdog-state.json");
    writeFileSync(progress, "- [x] Started\n- [ ] Finish\nstatus: in_progress\n");
    runWatchdog(progress);
    writeFileSync(progress, "- [x] Started\n- [ ] Finish\n- [ ] Document\nstatus: in_progress\n");

    const verdict = runWatchdog(progress);
    const persisted = JSON.parse(readFileSync(state, "utf8"));

    expect(verdict.reason).toBe("SCOPE");
    expect(verdict.notify).toBe(true);
    expect(persisted.version).toBe(2);
    expect(persisted.itemTexts).toEqual(["Started", "Finish", "Document"]);
  });

  test("reports blocker recovery", () => {
    const dir = tempDir();
    const progress = join(dir, "PROGRESS.md");
    writeFileSync(progress, "- [x] Started\n- [ ] BLOCKED: dependency unavailable\nstatus: blocked\n");
    runWatchdog(progress);
    writeFileSync(progress, "- [x] Started\n- [ ] Finish\nstatus: in_progress\n");

    const verdict = runWatchdog(progress);

    expect(verdict.reason).toBe("RECOVERY");
    expect(verdict.notify).toBe(true);
  });

  test("does not emit a duplicate stall while a known blocker remains", () => {
    const dir = tempDir();
    const progress = join(dir, "PROGRESS.md");
    const state = join(dir, ".watchdog-state.json");
    writeFileSync(progress, "- [x] Started\n- [ ] BLOCKED: dependency unavailable\nstatus: blocked\n");
    runWatchdog(progress);
    const persisted = JSON.parse(readFileSync(state, "utf8"));
    persisted.lastChangeTs = Date.now() - 120 * 60_000;
    writeFileSync(state, JSON.stringify(persisted));

    const verdict = runWatchdog(progress, "--stall-min", "45");

    expect(verdict.reason).toBe("SILENT");
    expect(verdict.notify).toBe(false);
  });

  test("reopened completion resets the completion notification latch", () => {
    const dir = tempDir();
    const progress = join(dir, "PROGRESS.md");
    const state = join(dir, ".watchdog-state.json");
    writeFileSync(progress, "- [x] Done\nstatus: complete\n");
    runWatchdog(progress);
    writeFileSync(progress, "- [x] Done\n- [ ] New phase\nstatus: in_progress\n");

    const verdict = runWatchdog(progress);
    const persisted = JSON.parse(readFileSync(state, "utf8"));

    expect(verdict.reason).toBe("REGRESSION");
    expect(persisted.completeNotified).toBe(false);
  });
});

describe("watchdog sweep", () => {
  test("consolidates actionable notifications into one digest", () => {
    const root = tempDir();
    const project = join(root, "Projects", "demo");
    const progress = join(project, "PROGRESS.md");
    mkdirSync(project, { recursive: true });
    writeFileSync(progress, "- [x] Started\n- [ ] Finish\nstatus: in_progress\n");
    runWatchdog(progress);
    writeFileSync(progress, "- [x] Started\n- [ ] BLOCKED: dependency unavailable\nstatus: blocked\n");

    const manifest = runSweep(root, "--dry-run");

    expect(manifest.notifications).toHaveLength(1);
    expect(manifest.digest.counts.attention).toBe(1);
    expect(manifest.digest.message).toContain("[BLOCKER]");
  });

  test("commits the exact preview so changes during delivery remain visible", () => {
    const root = tempDir();
    const project = join(root, "Projects", "demo");
    const progress = join(project, "PROGRESS.md");
    mkdirSync(project, { recursive: true });
    writeFileSync(progress, "- [x] Started\n- [ ] Finish\nstatus: in_progress\n");
    runWatchdog(progress);
    writeFileSync(progress, "- [x] Started\n- [x] Finish\nstatus: in_progress\n");

    const preview = runSweep(root, "--dry-run");
    expect(preview.notifications[0].reason).toBe("MILESTONE");
    expect(preview.acknowledgements).toHaveLength(1);

    writeFileSync(progress, "- [x] Started\n- [x] Finish\n- [ ] BLOCKED: deployment unavailable\nstatus: blocked\n");
    commitAcknowledgements(preview.acknowledgements);

    const nextPreview = runSweep(root, "--dry-run");
    expect(nextPreview.notifications[0].reason).toBe("BLOCKER");
    expect(nextPreview.digest.message).toContain("deployment unavailable");
  });

  test("retires completed projects after completion was acknowledged", () => {
    const root = tempDir();
    const project = join(root, "Projects", "demo");
    const progress = join(project, "PROGRESS.md");
    mkdirSync(project, { recursive: true });
    writeFileSync(progress, "- [x] Done\nstatus: complete\n");
    runWatchdog(progress);

    const manifest = runSweep(root, "--dry-run");

    expect(manifest.active).toEqual([]);
    expect(manifest.retired).toEqual([progress]);
  });
});
