import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("delete and invalid capacity", () => { const cache = new subject.TtlCache<string, number>(1, 1, () => 0); cache.set("a", 1); expect(cache.delete("a")).toBeTrue(); expect(cache.size).toBe(0); expect(() => new subject.TtlCache(0, 1)).toThrow(); });
