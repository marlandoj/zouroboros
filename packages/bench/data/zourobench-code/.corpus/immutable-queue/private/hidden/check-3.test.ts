import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("clone remaining",()=>{const x=[{id:"a",priority:1,createdAt:"1",state:"held" as const,attempt:0}];const r=subject.claimNext(x);r.remaining[0]!.attempt=9;expect(x[0]!.attempt).toBe(0)});
