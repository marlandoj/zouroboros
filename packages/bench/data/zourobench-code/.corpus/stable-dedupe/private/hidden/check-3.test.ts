import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("copies and preserves input", () => { const input=[{id:"a",value:1}]; const out=subject.dedupeById(input); out[0]!.value=9; expect(input[0]!.value).toBe(1); });
