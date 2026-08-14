import { expect, test } from "bun:test";
import * as subject from "../src/index";

test("rejects", async () => await expect(subject.mapConcurrent([1,2,3],1,async x=>{if(x===2) throw new Error("stop"); return x})).rejects.toThrow("stop"));
