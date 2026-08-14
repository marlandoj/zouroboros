import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("arrays replace", () => expect(subject.mergeProviderConfig({ models: ["a"] }, { models: ["b"] })).toEqual({ models: ["b"] }));
