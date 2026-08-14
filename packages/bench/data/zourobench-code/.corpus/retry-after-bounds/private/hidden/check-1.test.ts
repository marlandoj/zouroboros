import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("HTTP date", () => expect(subject.parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 1_000, 500, 10_000)).toBe(2_000));
