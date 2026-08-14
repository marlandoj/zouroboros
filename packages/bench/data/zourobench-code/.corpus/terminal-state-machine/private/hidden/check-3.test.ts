import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("terminal closed",()=>{expect(()=>subject.transition("done","failed")).toThrow();expect(()=>subject.transition("failed","running")).toThrow()});
