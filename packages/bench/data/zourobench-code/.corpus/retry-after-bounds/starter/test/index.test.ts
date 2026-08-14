import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("seconds", () => expect(subject.parseRetryAfter("2", 0, 500, 10_000)).toBe(2_000));
});
