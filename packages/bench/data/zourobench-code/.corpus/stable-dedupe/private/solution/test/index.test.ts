import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("first and stable", () => expect(subject.dedupeById([{ id: "b", value: 1 }, { id: "a", value: 2 }, { id: "b", value: 3 }])).toEqual([{ id: "b", value: 1 }, { id: "a", value: 2 }]));
});
