import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("order",()=>expect(subject.summarizeModels([{canonical:"z",route:"1",qualified:false,runnable:true,supported:true},{canonical:"a",route:"2",qualified:false,runnable:true,supported:true}]).models.map(x=>x.canonical)).toEqual(["a","z"]));
