import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("idempotent",()=>expect(subject.transition("failed","failed")).toBe("failed"));
