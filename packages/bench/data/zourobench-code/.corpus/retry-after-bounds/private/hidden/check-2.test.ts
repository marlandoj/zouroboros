import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("invalid and past fallback", () => { expect(subject.parseRetryAfter("bad", 0, 750, 10_000)).toBe(750); expect(subject.parseRetryAfter("Thu, 01 Jan 1970 00:00:00 GMT", 1_000, 750, 10_000)).toBe(750); });
