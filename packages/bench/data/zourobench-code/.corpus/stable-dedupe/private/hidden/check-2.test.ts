import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("reject empty", () => expect(() => subject.dedupeById([{id:" ",value:1}])).toThrow());
