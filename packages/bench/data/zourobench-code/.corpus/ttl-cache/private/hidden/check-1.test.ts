import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("LRU eviction", () => { const cache = new subject.TtlCache<string, number>(2, 100, () => 0); cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3); expect(cache.get("b")).toBeUndefined(); expect(cache.get("a")).toBe(1); });
