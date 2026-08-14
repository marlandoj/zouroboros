import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("four layers",()=>expect(subject.resolveConfig({retries:1},{model:"p"},{timeoutMs:3},{retries:2})).toEqual({retries:2,model:"p",timeoutMs:3}));
