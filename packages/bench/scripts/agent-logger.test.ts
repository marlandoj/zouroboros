import { test, expect } from "bun:test";
import { startFile } from "./agent-logger";

test("start file is namespaced per agent id", () => {
  const a = startFile("mem-index-vault");
  const b = startFile("zbr-heal-agent-models");
  expect(a).not.toBe(b);
  expect(a).toContain("mem-index-vault");
});

test("start file sanitizes unsafe characters", () => {
  expect(startFile("[MEM] Backfill/Embeddings")).toBe("/tmp/.agent-run-start--MEM--Backfill-Embeddings.json");
});

test("start file falls back to shared path without an agent id", () => {
  expect(startFile()).toBe("/tmp/.agent-run-start.json");
  expect(startFile("")).toBe("/tmp/.agent-run-start.json");
});
