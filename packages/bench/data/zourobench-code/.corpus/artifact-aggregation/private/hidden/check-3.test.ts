import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("newest duplicate id",()=>{const x=[{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:1,score:1},{id:"a",timestamp:"2026-01-02",context:"x",index:1,seed:1,minimumN:1,score:9}];expect(subject.aggregateRuns(x).mean).toBe(9)});
