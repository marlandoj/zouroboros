import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("snapshot copy and bounds",()=>{expect(()=>new subject.SlidingWindowLimiter(0,1)).toThrow();const l=new subject.SlidingWindowLimiter(1,1);l.allow(0);const x=l.snapshot();x.push(9);expect(l.snapshot()).toEqual([0])});
