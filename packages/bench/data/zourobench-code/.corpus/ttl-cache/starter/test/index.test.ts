import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("stores a value", () => { const cache = new subject.TtlCache<string, number>(2, 100, () => 0); cache.set("a", 1); expect(cache.get("a")).toBe(1); });
});
