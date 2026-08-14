import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("never throws", () => expect(() => subject.parsePort("not-a-port")).not.toThrow());
