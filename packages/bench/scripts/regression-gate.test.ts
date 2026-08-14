import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { computeDiff, readJsonFile, shouldUpdateBaseline } from "./regression-gate";

// ── ZOU-404: missing baseline category is a regression, not a silent skip ──

test("computeDiff flags a baseline category missing from the current run as a regression", () => {
  const baseline = { overall: 0.9, "memory.recall": 0.8, "memory.negation": 0.7 };
  const current = { overall: 0.9, "memory.recall": 0.8 }; // negation vanished
  const diff = computeDiff(current, baseline);

  expect(diff.regressions.some(r => r.includes("memory.negation"))).toBe(true);
  expect(diff.regressions.some(r => r.includes("MISSING"))).toBe(true);
  // the entire dimension is lost, so worst regression reflects the full score
  expect(diff.worstRegression).toBeCloseTo(0.7, 5);
});

test("computeDiff does not flag categories present in both runs and stable", () => {
  const baseline = { overall: 0.9, "memory.recall": 0.8 };
  const current = { overall: 0.9, "memory.recall": 0.8 };
  const diff = computeDiff(current, baseline);
  expect(diff.regressions.length).toBe(0);
});

test("computeDiff still detects a normal score regression", () => {
  const baseline = { overall: 0.9, "memory.recall": 0.80 };
  const current = { overall: 0.9, "memory.recall": 0.70 }; // -10pts
  const diff = computeDiff(current, baseline);
  expect(diff.regressions.some(r => r.includes("memory.recall"))).toBe(true);
  expect(diff.worstRegression).toBeCloseTo(0.10, 5);
});

// ── ZOU-403: JSON loads surface IO/parse failures instead of silently throwing ──

test("readJsonFile parses a valid JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "qg-"));
  try {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ a: 1, b: [2, 3] }));
    expect(readJsonFile(p)).toEqual({ a: 1, b: [2, 3] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonFile throws a descriptive error on corrupt JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "qg-"));
  try {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, '{ "overall": 0.9, ');  // truncated / partially written
    expect(() => readJsonFile(p)).toThrow(/invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonFile throws a descriptive error when the file is unreadable", () => {
  expect(() => readJsonFile("/nonexistent/path/does-not-exist.json")).toThrow(/unable to read/);
});

// ── ZOU-400 (regression guard): anti-ratchet promotion logic still holds ──

test("shouldUpdateBaseline: only a clean pass or explicit override promotes the floor", () => {
  expect(shouldUpdateBaseline("pass")).toBe(true);
  expect(shouldUpdateBaseline("fail")).toBe(false);
  expect(shouldUpdateBaseline("warn")).toBe(false);
  expect(shouldUpdateBaseline("bootstrap")).toBe(true);
  expect(shouldUpdateBaseline("fail", { updateBaseline: true })).toBe(true);
  expect(shouldUpdateBaseline("warn", { baselineOnly: true })).toBe(true);
});
