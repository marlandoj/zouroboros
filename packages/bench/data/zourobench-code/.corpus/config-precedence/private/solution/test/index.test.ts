import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("undefined and null",()=>expect(subject.resolveConfig({model:"a",timeoutMs:1},{model:undefined,timeoutMs:null})).toEqual({model:"a",timeoutMs:null}));
});
