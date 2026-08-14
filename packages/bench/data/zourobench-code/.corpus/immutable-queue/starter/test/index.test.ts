import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("priority",()=>expect(subject.claimNext([{id:"a",priority:1,createdAt:"1",state:"ready",attempt:0},{id:"b",priority:2,createdAt:"2",state:"ready",attempt:0}]).selected?.id).toBe("b"));
});
