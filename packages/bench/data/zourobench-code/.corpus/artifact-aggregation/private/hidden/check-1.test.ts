import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("underpowered",()=>expect(()=>subject.aggregateRuns([{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:2,score:80}])).toThrow());
