import { describe, expect, test } from "bun:test";
import { probeCredentials } from "./probe-credentials";

describe("probeCredentials", () => {
  test("reports presence without exposing values", () => {
    expect(probeCredentials({ FAL_KEY: "secret", TRIPO_API_KEY: "", ELEVENLABS_API_KEY: undefined })).toEqual({
      FAL_KEY: "SET",
      TRIPO_API_KEY: "MISSING",
      ELEVENLABS_API_KEY: "MISSING",
    });
  });
});

