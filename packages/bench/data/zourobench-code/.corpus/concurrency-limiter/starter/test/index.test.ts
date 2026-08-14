import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("maps", async () => expect(await subject.mapConcurrent([1,2], 1, async x => x * 2)).toEqual([2,4]));
});
