import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("invalid",()=>{expect(()=>subject.estimateCostMicros(-1,0,1,1)).toThrow();expect(()=>subject.estimateCostMicros(1,0,Number.NaN,1)).toThrow()});
