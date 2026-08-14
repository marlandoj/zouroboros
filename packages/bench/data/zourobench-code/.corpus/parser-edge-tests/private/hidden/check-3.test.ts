import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("missing",()=>{expect(()=>subject.parseModelRoute("or:")).toThrow();expect(()=>subject.parseModelRoute(":x")).toThrow()});
