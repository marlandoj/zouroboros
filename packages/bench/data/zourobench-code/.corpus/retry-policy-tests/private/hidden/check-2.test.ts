import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("date",()=>expect(subject.retryDelayMs(429,"Thu, 01 Jan 1970 00:00:03 GMT",1000)).toBe(2000));
