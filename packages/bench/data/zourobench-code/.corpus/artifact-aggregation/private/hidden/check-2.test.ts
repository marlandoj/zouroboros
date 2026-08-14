import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("context and replicate uniqueness",()=>{const a={id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:2,score:80};expect(()=>subject.aggregateRuns([a,{...a,id:"b",context:"y",index:2,seed:2}])).toThrow();expect(()=>subject.aggregateRuns([a,{...a,id:"b"}])).toThrow()});
