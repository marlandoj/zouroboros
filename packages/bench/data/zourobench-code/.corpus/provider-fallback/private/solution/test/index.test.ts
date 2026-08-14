import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("diverse first", () => { const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const}; const c=[{id:"b",provider:"p1",family:"f2",health:"healthy" as const},{id:"c",provider:"p2",family:"f2",health:"healthy" as const}]; expect(subject.selectFallback(f,c)?.id).toBe("c"); });
});
