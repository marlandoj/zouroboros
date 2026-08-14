import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("cycle",()=>expect(()=>subject.topologicalLayers([{id:"a",dependsOn:["b"]},{id:"b",dependsOn:["a"]}])).toThrow());
