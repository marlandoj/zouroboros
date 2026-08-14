import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("large",()=>expect(subject.estimateCostMicros(1_000_000,2_000_000,2.5,3)).toBe(8_500_000));
