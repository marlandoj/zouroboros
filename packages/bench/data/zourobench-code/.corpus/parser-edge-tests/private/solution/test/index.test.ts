import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("routes and boundaries",()=>{expect(subject.parseModelRoute(" or:vendor/model ")).toEqual({provider:"or",model:"vendor/model"});expect(()=>subject.parseModelRoute("bad")).toThrow();expect(()=>subject.parseModelRoute("x:y")).toThrow();expect(subject.parseModelRoute("or:a:b").model).toBe("a:b")});
});
