import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("valid", () => expect(subject.parsePort("8080")).toEqual({ ok: true, value: 8080 }));
});
