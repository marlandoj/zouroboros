import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("terminal",()=>{expect(subject.transition("running","done")).toBe("done");expect(()=>subject.transition("done","running")).toThrow()});
});
