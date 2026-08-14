import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("provider and cost",()=>expect(subject.rankCandidates([{id:"b",floor:1,providerRank:2,cost:0},{id:"a",floor:1,providerRank:1,cost:9},{id:"c",floor:1,providerRank:1,cost:1}]).map(x=>x.id)).toEqual(["c","a","b"]));
