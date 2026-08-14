import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("top-level merge", () => expect(subject.mergeProviderConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 }));
});
