import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("cap and status",()=>{expect(subject.retryDelayMs(429,"99",0,4000)).toBe(4000);expect(subject.retryDelayMs(401,null,0)).toBeNull()});
