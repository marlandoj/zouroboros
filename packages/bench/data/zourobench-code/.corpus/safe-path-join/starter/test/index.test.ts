import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("child",()=>expect(subject.safeJoin("/tmp/root","a.json")).toBe("/tmp/root/a.json"));
});
