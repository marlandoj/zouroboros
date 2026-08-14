import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("order", () => expect(subject.dedupeById([{id:"z",value:1},{id:"a",value:2}]).map(x=>x.id)).toEqual(["z","a"]));
