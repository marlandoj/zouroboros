import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("sibling prefix",()=>expect(()=>subject.safeJoin("/tmp/root","../root2/x")).toThrow());
