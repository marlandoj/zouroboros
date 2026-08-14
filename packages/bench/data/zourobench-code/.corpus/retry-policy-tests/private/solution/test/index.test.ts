import { describe, expect, test } from "bun:test";
import * as subject from "../src/index";

describe("task", () => {
  test("seconds dates caps and status",()=>{expect(subject.retryDelayMs(429,"2",0)).toBe(2000);expect(subject.retryDelayMs(429,"Thu, 01 Jan 1970 00:00:03 GMT",1000)).toBe(2000);expect(subject.retryDelayMs(429,"99",0,4000)).toBe(4000);expect(subject.retryDelayMs(400,null,0)).toBeNull()});
});
