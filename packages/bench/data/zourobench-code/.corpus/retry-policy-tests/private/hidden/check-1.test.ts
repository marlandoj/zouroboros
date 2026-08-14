import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("source unchanged",()=>expect(subject.retryDelayMs(503,null,0)).toBe(1000));
