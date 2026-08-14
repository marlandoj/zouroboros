import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("counts",()=>expect(subject.summarizeModels([{canonical:"a",route:"r",qualified:true,runnable:true,supported:true}]).qualified).toBe(1));
});
