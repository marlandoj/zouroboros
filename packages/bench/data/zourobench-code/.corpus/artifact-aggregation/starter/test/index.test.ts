import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("mean",()=>expect(subject.aggregateRuns([{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:1,score:80}])).toEqual({mean:80,standardDeviation:0,n:1}));
});
