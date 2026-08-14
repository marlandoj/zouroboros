import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("invalid limit", async () => { let calls=0; await expect(subject.mapConcurrent([1],0,async x=>{calls++;return x})).rejects.toThrow(); expect(calls).toBe(0); });
