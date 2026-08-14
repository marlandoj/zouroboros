import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("starts",()=>expect(subject.transition("queued","running")).toBe("running"));
});
