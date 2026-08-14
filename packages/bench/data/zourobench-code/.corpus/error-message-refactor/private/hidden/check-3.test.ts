import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("bearer case",()=>expect(subject.providerError({kind:"timeout",provider:"p",message:"bearer ABC_123"})).toContain("[REDACTED]"));
