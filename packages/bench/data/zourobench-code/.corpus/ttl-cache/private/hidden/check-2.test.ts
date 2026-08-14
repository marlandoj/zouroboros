import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("overwrite does not inflate size", () => { const cache = new subject.TtlCache<string, number>(2, 100, () => 0); cache.set("a", 1); cache.set("a", 2); expect(cache.size).toBe(1); expect(cache.get("a")).toBe(2); });
