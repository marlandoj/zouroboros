import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("pollution blocked", () => { const bad = JSON.parse('{"__proto__":{"polluted":true}}'); expect(() => subject.mergeProviderConfig({}, bad)).toThrow(); });
