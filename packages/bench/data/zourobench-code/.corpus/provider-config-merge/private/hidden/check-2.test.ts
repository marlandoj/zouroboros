import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("inputs are immutable", () => { const base = { p: { x: 1 } }; const over = { p: { y: 2 } }; const result = subject.mergeProviderConfig(base, over) as any; result.p.x = 9; expect(base.p.x).toBe(1); expect(over.p.y).toBe(2); });
