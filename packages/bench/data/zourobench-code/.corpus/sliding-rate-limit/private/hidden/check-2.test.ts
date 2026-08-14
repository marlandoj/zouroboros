import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("clock",()=>{const l=new subject.SlidingWindowLimiter(1,10);l.allow(5);expect(()=>l.allow(4)).toThrow()});
