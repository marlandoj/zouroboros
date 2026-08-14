import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("parse",()=>expect(subject.providerError({kind:"parse",provider:"or",message:"bad json"})).toBe("[or] parse: bad json"));
