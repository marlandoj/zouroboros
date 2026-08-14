import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("http",()=>expect(subject.providerError({kind:"http",provider:"p",status:500,message:"bad"})).toBe("[p] HTTP 500: bad"));
});
