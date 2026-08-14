import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("rejects malformed", () => { for (const value of ["0", "65536", "1.5", "", "12x"]) expect(subject.parsePort(value).ok).toBeFalse(); });
