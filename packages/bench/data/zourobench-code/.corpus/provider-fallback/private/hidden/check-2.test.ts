import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("relaxes family",()=>{const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const};expect(subject.selectFallback(f,[{id:"x",provider:"p2",family:"f1",health:"healthy"}])?.id).toBe("x")});
