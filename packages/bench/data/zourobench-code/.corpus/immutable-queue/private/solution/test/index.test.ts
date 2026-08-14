import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("pure",()=>{const x=[{id:"a",priority:1,createdAt:"1",state:"ready" as const,attempt:0}];const r=subject.claimNext(x);expect(r.selected?.attempt).toBe(1);expect(x[0]!.attempt).toBe(0)});
});
