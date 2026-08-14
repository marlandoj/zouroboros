import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("immutable",()=>{const x={model:"a"};const r=subject.resolveConfig(x);r.model="b";expect(x.model).toBe("a")});
