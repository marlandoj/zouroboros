import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("limits",()=>{const l=new subject.SlidingWindowLimiter(1,10);expect(l.allow(0)).toBeTrue();expect(l.allow(1)).toBeFalse()});
});
