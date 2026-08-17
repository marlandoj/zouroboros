import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireTicketClaim,
  reconcileExpiredTicketClaims,
  ticketClaimKey,
  ticketClaimLeaseMs,
} from "./ticket-claim";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-ticket-claim-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("atomic ticket claim", () => {
  test("uses only the immutable Linear ticket_id as the claim key", () => {
    expect(ticketClaimKey("linear-uuid")).toBe(ticketClaimKey("linear-uuid"));
    expect(ticketClaimKey("linear-uuid")).not.toBe(ticketClaimKey("ZOU-924"));
  });

  test("concurrency one acquires and preserves the configured bounded lease", () => {
    const root = sandbox();
    const nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const result = acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-one" },
      { stateDir: root, nowMs, leaseMs: 10 * 60_000 },
    );
    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") throw new Error("expected ticket claim acquisition");
    expect(result.record.ticket_id).toBe("linear-uuid");
    expect(result.record.execution_id).toBe("exec-one");
    expect(Date.parse(result.record.lease_expires_at) - nowMs).toBe(10 * 60_000);
  });

  test("contention skips the second cycle and never replaces the owner", () => {
    const root = sandbox();
    const first = acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-one" }, { stateDir: root });
    const second = acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-two" }, { stateDir: root });
    expect(first.status).toBe("acquired");
    expect(second.status).toBe("contended");
    if (second.status !== "contended") throw new Error("expected ticket claim contention");
    expect(second.record.execution_id).toBe("exec-one");
  });

  test("production conveyor and reaper wire the claim lifecycle", () => {
    const conveyor = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    const claimIndex = conveyor.indexOf("const claim = acquireTicketClaim(");
    const classifyIndex = conveyor.indexOf("const verdict = classifyDispatch(", claimIndex);
    expect(claimIndex).toBeGreaterThan(0);
    expect(classifyIndex).toBeGreaterThan(claimIndex);

    const reaper = readFileSync(join(import.meta.dir, "reap-stale-execs.ts"), "utf8");
    expect(reaper).toContain("const claims = reconcileExpiredTicketClaims({");
  });

  test("corrupt and unreadable claim stores fail closed", () => {
    const corruptRoot = sandbox();
    const claimDir = join(corruptRoot, "ticket-claims", ticketClaimKey("linear-uuid"));
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "owner.json"), "not-json");
    expect(acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-two" }, { stateDir: corruptRoot }).status).toBe("unavailable");

    const blockedRoot = sandbox();
    writeFileSync(join(blockedRoot, "ticket-claims"), "not-a-directory");
    expect(acquireTicketClaim({ ticket_id: "other-uuid", execution_id: "exec-three" }, { stateDir: blockedRoot }).status).toBe("unavailable");
  });

  test("expired claims remain contended until the existing reaper reconciles them", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    expect(acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-old" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");
    const expired = acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-new" },
      { stateDir: root, nowMs: start + 6 * 60_000, leaseMs: 5 * 60_000 },
    );
    expect(expired.status).toBe("contended");
    if (expired.status !== "contended") throw new Error("expected expired claim contention");
    expect(expired.reason).toContain("reaper");

    const dryRun = reconcileExpiredTicketClaims({ stateDir: root, nowMs: start + 6 * 60_000, dryRun: true });
    expect(dryRun.planned).toEqual(["linear-uuid"]);
    expect(acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-new" }, { stateDir: root }).status).toBe("contended");

    const reconciled = reconcileExpiredTicketClaims({ stateDir: root, nowMs: start + 6 * 60_000 });
    expect(reconciled.reclaimed).toEqual(["linear-uuid"]);
    expect(acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-new" },
      { stateDir: root, nowMs: start + 6 * 60_000, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");
  });

  test("reaper preserves an expired claim while its execution is live", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-live" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    const result = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      executionAlive: (claim) => claim.execution_id === "exec-live",
    });
    expect(result.reclaimed).toEqual([]);
    expect(result.kept).toBe(1);
  });

  test("lease configuration rejects unbounded or malformed values", () => {
    expect(ticketClaimLeaseMs("5")).toBe(5 * 60_000);
    expect(ticketClaimLeaseMs("120")).toBe(120 * 60_000);
    expect(() => ticketClaimLeaseMs("4")).toThrow("between 5 and 120");
    expect(() => ticketClaimLeaseMs("121")).toThrow("between 5 and 120");
    expect(() => ticketClaimLeaseMs("invalid")).toThrow("between 5 and 120");
  });

  test("two concurrent cycles create exactly one dispatch and one PR side effect", async () => {
    const root = sandbox();
    const dispatchPath = join(root, "dispatches.txt");
    const prPath = join(root, "prs.txt");
    const worker = join(import.meta.dir, "ticket-claim-worker.ts");
    const spawn = (executionId: string) => Bun.spawn([
      "bun", worker, root, "linear-uuid", executionId, dispatchPath, prPath,
    ], { stdout: "pipe", stderr: "pipe" });
    const first = spawn("exec-cycle-a");
    const second = spawn("exec-cycle-b");
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines(dispatchPath)).toHaveLength(1);
    expect(lines(prPath)).toHaveLength(1);
    expect(lines(dispatchPath)).toEqual(lines(prPath));
  });
});
