import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("rounding",()=>{expect(subject.estimateCostMicros(1,0,.5,0)).toBe(1);expect(subject.estimateCostMicros(0,0,9,9)).toBe(0);expect(subject.estimateCostMicros(1_000_000,0,2.5,0)).toBe(2_500_000)});
});
