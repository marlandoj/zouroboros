import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("limits and reopens",()=>{const l=new subject.SlidingWindowLimiter(1,10);expect(l.allow(0)).toBeTrue();expect(l.allow(1)).toBeFalse();expect(l.allow(10)).toBeTrue()});
});
