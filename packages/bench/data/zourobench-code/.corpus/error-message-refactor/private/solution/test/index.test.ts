import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("redacts",()=>expect(subject.providerError({kind:"timeout",provider:"p",message:"Bearer abc.def"})).not.toContain("abc.def"));
});
