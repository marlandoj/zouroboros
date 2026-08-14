import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("unknown",()=>expect(()=>subject.resolveConfig({extra:1} as any)).toThrow());
