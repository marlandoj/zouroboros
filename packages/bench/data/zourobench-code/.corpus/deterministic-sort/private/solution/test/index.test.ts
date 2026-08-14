import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("measured",()=>expect(subject.rankCandidates([{id:"u",floor:null,providerRank:0,cost:0},{id:"m",floor:0,providerRank:9,cost:9}]).map(x=>x.id)).toEqual(["m","u"]));
});
