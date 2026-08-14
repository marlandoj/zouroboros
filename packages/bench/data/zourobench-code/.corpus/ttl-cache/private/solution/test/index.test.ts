import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("stores and expires", () => { let now = 0; const cache = new subject.TtlCache<string, number>(2, 10, () => now); cache.set("a", 1); expect(cache.get("a")).toBe(1); now = 10; expect(cache.get("a")).toBeUndefined(); });
});
