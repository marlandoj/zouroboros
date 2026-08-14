import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("absolute",()=>expect(()=>subject.safeJoin("/tmp/root","/etc/passwd")).toThrow());
