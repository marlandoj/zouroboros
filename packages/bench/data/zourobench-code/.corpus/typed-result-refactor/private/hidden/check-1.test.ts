import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("bounds", () => { expect(subject.parsePort("1")).toEqual({ ok: true, value: 1 }); expect(subject.parsePort("65535")).toEqual({ ok: true, value: 65535 }); });
