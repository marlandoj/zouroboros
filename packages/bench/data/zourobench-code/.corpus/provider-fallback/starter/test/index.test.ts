import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("healthy", () => { const failed={id:"a",provider:"p1",family:"f1",health:"healthy" as const}; expect(subject.selectFallback(failed,[failed,{id:"b",provider:"p2",family:"f2",health:"healthy"}])?.id).toBe("b"); });
});
