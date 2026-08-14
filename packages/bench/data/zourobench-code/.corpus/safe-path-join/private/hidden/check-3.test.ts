import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("root itself",()=>expect(()=>subject.safeJoin("/tmp/root",".")).toThrow());
