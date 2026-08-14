import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("all states",()=>{const x=[{canonical:"q",route:"1",qualified:false,runnable:true,supported:true},{canonical:"h",route:"2",qualified:false,runnable:false,supported:true},{canonical:"u",route:"3",qualified:false,runnable:false,supported:false}];expect(subject.summarizeModels(x)).toMatchObject({qualified:0,queued:1,held:1,unsupported:1})});
