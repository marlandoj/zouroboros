import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("source behavior",()=>expect(subject.estimateCostMicros(1,0,.5,0)).toBe(1));
