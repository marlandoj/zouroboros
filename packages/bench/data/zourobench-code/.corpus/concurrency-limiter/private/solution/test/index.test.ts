import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("order", async () => expect(await subject.mapConcurrent([1,2,3], 2, async x => { await Bun.sleep(4-x); return x; })).toEqual([1,2,3]));
});
