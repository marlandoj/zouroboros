import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("immutable",()=>{const x=[{id:"b",floor:1,providerRank:1,cost:1},{id:"a",floor:1,providerRank:1,cost:1}];subject.rankCandidates(x);expect(x.map(v=>v.id)).toEqual(["b","a"])});
