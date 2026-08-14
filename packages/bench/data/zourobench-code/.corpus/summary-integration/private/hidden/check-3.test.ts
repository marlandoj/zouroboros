import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("immutable",()=>{const x=[{canonical:"a",route:"z",qualified:false,runnable:true,supported:true},{canonical:"a",route:"a",qualified:true,runnable:true,supported:true}];subject.summarizeModels(x);expect(x[0]!.route).toBe("z")});
