import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("seconds, fallback, and cap", () => {
    expect(subject.parseRetryAfter("2", 0, 500, 10_000)).toBe(2_000);
    expect(subject.parseRetryAfter(null, 0, 500, 10_000)).toBe(500);
    expect(subject.parseRetryAfter("99", 0, 500, 4_000)).toBe(4_000);
  });
});
