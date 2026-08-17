import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeExecutionCount, inflightCap, pullLimit } from "./inflight-cap";
import { pickHighestPriority, type IntakeTicket } from "./linear-puller";

function ticket(identifier: string, priority: number, createdAt: string): IntakeTicket {
  return {
    linear_id: identifier,
    identifier,
    title: identifier,
    description: "",
    url: "",
    state: "Backlog",
    state_type: "backlog",
    labels: ["factory-ready"],
    created_at: createdAt,
    updated_at: createdAt,
    priority,
  };
}

describe("inflightCap", () => {
  test("defaults to 1 when the flag is unset or empty", () => {
    expect(inflightCap({})).toBe(1);
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "" })).toBe(1);
  });

  test("reads explicit values 1-3", () => {
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "1" })).toBe(1);
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "2" })).toBe(2);
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "3" })).toBe(3);
  });

  test("fails closed on invalid explicit values", () => {
    for (const bad of ["0", "4", "-1", "2.5", "two", "20"]) {
      expect(() => inflightCap({ FACTORY_INFLIGHT_CAP: bad })).toThrow("FACTORY_INFLIGHT_CAP invalid");
    }
  });
});

describe("pullLimit", () => {
  test("per-cycle batch stays 1 with full headroom", () => {
    expect(pullLimit(0, 1)).toBe(1);
    expect(pullLimit(0, 2)).toBe(1);
    expect(pullLimit(0, 3)).toBe(1);
  });

  test("admits a new pull while a prior execution is live under a raised cap", () => {
    expect(pullLimit(1, 2)).toBe(1);
    expect(pullLimit(2, 3)).toBe(1);
  });

  test("withholds the queue at or above the cap", () => {
    expect(pullLimit(1, 1)).toBe(0);
    expect(pullLimit(2, 2)).toBe(0);
    expect(pullLimit(3, 2)).toBe(0);
  });
});

describe("activeExecutionCount", () => {
  test("counts only executing records and survives torn files", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-test-"));
    writeFileSync(join(dir, "exec-a.json"), JSON.stringify({ status: "executing", completed_at: null }));
    writeFileSync(
      join(dir, "exec-b.json"),
      JSON.stringify({ status: "implementation_complete", completed_at: "2026-08-13T00:00:00Z" }),
    );
    writeFileSync(join(dir, "exec-c.json"), "{torn");
    writeFileSync(join(dir, "unrelated.txt"), "ignore me");
    expect(activeExecutionCount(dir)).toBe(1);
  });

  test("missing state dir counts zero", () => {
    expect(activeExecutionCount("/tmp/does-not-exist-inflight-cap")).toBe(0);
  });
});

describe("pickHighestPriority limit", () => {
  const pool = [
    ticket("ZOU-3", 1, "2026-08-11T00:03:00Z"),
    ticket("ZOU-1", 2, "2026-08-11T00:01:00Z"),
    ticket("ZOU-2", 1, "2026-08-11T00:02:00Z"),
  ];

  test("default limit preserves the single-ticket batch", () => {
    expect(pickHighestPriority(pool).map((t) => t.identifier)).toEqual(["ZOU-2"]);
  });

  test("limit 0 returns an empty queue", () => {
    expect(pickHighestPriority(pool, 0)).toEqual([]);
  });

  test("limit 2 keeps urgent-first FIFO ordering", () => {
    expect(pickHighestPriority(pool, 2).map((t) => t.identifier)).toEqual(["ZOU-2", "ZOU-3"]);
  });
});
