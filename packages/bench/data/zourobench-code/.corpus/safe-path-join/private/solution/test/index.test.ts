import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("child, traversal, and sibling escape",()=>{expect(subject.safeJoin("/tmp/root","a.json")).toBe("/tmp/root/a.json");expect(()=>subject.safeJoin("/tmp/root","../x")).toThrow();expect(()=>subject.safeJoin("/tmp/root","../root2/x")).toThrow()});
});
