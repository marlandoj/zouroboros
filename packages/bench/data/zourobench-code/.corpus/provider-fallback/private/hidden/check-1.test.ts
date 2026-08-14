import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("skips held",()=>{const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const};expect(subject.selectFallback(f,[{id:"x",provider:"p2",family:"f2",health:"held"}])).toBeNull()});
