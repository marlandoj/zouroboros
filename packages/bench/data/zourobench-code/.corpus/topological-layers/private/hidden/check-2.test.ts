import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("missing",()=>expect(()=>subject.topologicalLayers([{id:"a",dependsOn:["x"]}])).toThrow());
