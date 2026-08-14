import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("order within tier",()=>{const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const};const c=[{id:"x",provider:"p2",family:"f2",health:"healthy" as const},{id:"y",provider:"p3",family:"f3",health:"healthy" as const}];expect(subject.selectFallback(f,c)?.id).toBe("x")});
