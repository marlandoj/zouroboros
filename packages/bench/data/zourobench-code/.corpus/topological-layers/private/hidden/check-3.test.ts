import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("duplicate and immutable",()=>{expect(()=>subject.topologicalLayers([{id:"a",dependsOn:[]},{id:"a",dependsOn:[]}])).toThrow();const n=[{id:"a",dependsOn:[]}];subject.topologicalLayers(n);expect(n).toEqual([{id:"a",dependsOn:[]}])});
