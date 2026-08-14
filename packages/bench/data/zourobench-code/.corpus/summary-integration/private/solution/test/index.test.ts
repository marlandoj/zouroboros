import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("dedupes",()=>expect(subject.summarizeModels([{canonical:"a",route:"z",qualified:false,runnable:true,supported:true},{canonical:"a",route:"a",qualified:true,runnable:true,supported:true}])).toEqual({models:[{canonical:"a",route:"a"}],qualified:1,queued:0,held:0,unsupported:0}));
});
