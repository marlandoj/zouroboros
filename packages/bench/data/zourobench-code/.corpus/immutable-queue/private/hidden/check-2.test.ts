import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("held",()=>expect(subject.claimNext([{id:"a",priority:9,createdAt:"1",state:"held",attempt:0},{id:"b",priority:1,createdAt:"2",state:"ready",attempt:0}]).selected?.id).toBe("b"));
