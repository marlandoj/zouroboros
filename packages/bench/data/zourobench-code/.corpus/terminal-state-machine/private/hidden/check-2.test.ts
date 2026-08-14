import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("queued cannot finish",()=>expect(()=>subject.transition("queued","done")).toThrow());
