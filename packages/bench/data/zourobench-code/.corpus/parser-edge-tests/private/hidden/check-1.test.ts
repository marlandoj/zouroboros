import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("source behavior",()=>expect(subject.parseModelRoute("or:a:b")).toEqual({provider:"or",model:"a:b"}));
