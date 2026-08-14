import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("nested merge", () => expect(subject.mergeProviderConfig({ p: { url: "a", headers: { x: 1 } } }, { p: { headers: { y: 2 } } })).toEqual({ p: { url: "a", headers: { x: 1, y: 2 } } }));
});
