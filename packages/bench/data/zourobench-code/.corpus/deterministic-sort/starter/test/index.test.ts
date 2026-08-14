import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("floor",()=>expect(subject.rankCandidates([{id:"a",floor:1,providerRank:1,cost:1},{id:"b",floor:2,providerRank:1,cost:1}]).map(x=>x.id)).toEqual(["b","a"]));
});
