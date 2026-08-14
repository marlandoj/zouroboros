import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("valid and invalid", () => { expect(subject.parsePort("8080")).toEqual({ ok: true, value: 8080 }); expect(subject.parsePort("x").ok).toBeFalse(); });
});
