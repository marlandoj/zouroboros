import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("bound", async () => { let active=0,max=0; await subject.mapConcurrent([1,2,3,4],2,async x=>{active++;max=Math.max(max,active);await Bun.sleep(5);active--;return x}); expect(max).toBe(2); });
