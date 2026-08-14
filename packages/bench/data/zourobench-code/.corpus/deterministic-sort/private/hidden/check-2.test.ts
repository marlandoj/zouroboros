import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("id tie",()=>expect(subject.rankCandidates([{id:"z",floor:null,providerRank:1,cost:1},{id:"a",floor:null,providerRank:1,cost:1}]).map(x=>x.id)).toEqual(["a","z"]));
