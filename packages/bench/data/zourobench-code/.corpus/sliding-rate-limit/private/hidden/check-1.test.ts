import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("inclusive boundary policy",()=>{const l=new subject.SlidingWindowLimiter(2,10);expect(l.allow(0)).toBeTrue();expect(l.allow(9)).toBeTrue();expect(l.allow(10)).toBeTrue();expect(l.snapshot()).toEqual([9,10])});
