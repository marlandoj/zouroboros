import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("parallel deterministic",()=>expect(subject.topologicalLayers([{id:"b",dependsOn:[]},{id:"a",dependsOn:[]},{id:"c",dependsOn:["a","b"]}])).toEqual([["a","b"],["c"]]));
});
