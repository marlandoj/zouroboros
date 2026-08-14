import { describe, expect, test } from "bun:test";
import { parseSpeakersFromTitle, parseSpeakersFromTranscript } from "./backfill-speakers";

describe("parseSpeakersFromTitle", () => {
  test("extracts one speaker and organization from an em-dash suffix", () => {
    expect(parseSpeakersFromTitle("Why Agents Fail — Diane Lin, Datadog")).toEqual({
      speakers: ["Diane Lin"],
      source: "title",
      confidence: 0.96,
    });
  });

  test("extracts multiple speakers", () => {
    expect(parseSpeakersFromTitle("Don't Let the LLM Drive - Ornella Bahidika & Joel Allou, Microsoft").speakers)
      .toEqual(["Ornella Bahidika", "Joel Allou"]);
  });

  test("does not classify a bare organization as a person", () => {
    expect(parseSpeakersFromTitle("AI Engineering Trends — Anthropic").speakers).toEqual([]);
  });
});

describe("parseSpeakersFromTranscript", () => {
  test("uses a first-person introduction as fallback", () => {
    expect(parseSpeakersFromTranscript("## Transcript\n\nHi, my name is Manoj Nair and I lead security.").speakers)
      .toEqual(["Manoj Nair"]);
  });
});
