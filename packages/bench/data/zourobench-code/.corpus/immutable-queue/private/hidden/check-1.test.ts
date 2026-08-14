import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("ties",()=>expect(subject.claimNext([{id:"b",priority:1,createdAt:"1",state:"ready",attempt:0},{id:"a",priority:1,createdAt:"1",state:"ready",attempt:0}]).selected?.id).toBe("a"));
