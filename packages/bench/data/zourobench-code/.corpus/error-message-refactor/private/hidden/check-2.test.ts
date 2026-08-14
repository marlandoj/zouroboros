import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("query secrets",()=>expect(subject.providerError({kind:"http",provider:"p",status:401,message:"https://x?a=1&token=secret&b=2"})).not.toContain("secret"));
