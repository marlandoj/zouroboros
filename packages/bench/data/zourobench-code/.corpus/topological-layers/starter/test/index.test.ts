import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("layers",()=>expect(subject.topologicalLayers([{id:"a",dependsOn:[]},{id:"b",dependsOn:["a"]}])).toEqual([["a"],["b"]]));
});
