import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("cap", () => expect(subject.parseRetryAfter("99", 0, 500, 4_000)).toBe(4_000));
