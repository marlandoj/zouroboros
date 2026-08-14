import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("sample spread",()=>expect(subject.aggregateRuns([{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:2,score:80},{id:"b",timestamp:"2026-01-01",context:"x",index:2,seed:2,minimumN:2,score:100}]).standardDeviation).toBeCloseTo(14.1421,3));
});
