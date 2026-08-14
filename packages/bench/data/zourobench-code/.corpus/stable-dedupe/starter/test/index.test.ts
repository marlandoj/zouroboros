import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("dedupes", () => expect(subject.dedupeById([{ id: "a", value: 1 }, { id: "a", value: 2 }])).toEqual([{ id: "a", value: 1 }]));
});
