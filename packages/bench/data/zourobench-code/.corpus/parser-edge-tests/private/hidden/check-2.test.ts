import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("unknown",()=>expect(()=>subject.parseModelRoute("unknown:model")).toThrow());
