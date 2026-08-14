import { describe, expect, test } from "bun:test";
import { extractFrontmatterUrl, extractYoutubeUrl, mergeCatalog, parseTranscriptProviderOutput, stablePointId } from "./ingest-utils";

describe("stablePointId", () => {
  test("is deterministic and separates metadata from transcript chunks", () => {
    expect(stablePointId("metadata", "abc")).toBe(stablePointId("metadata", "abc"));
    expect(stablePointId("metadata", "abc")).not.toBe(stablePointId("transcript", "abc", 0));
    expect(stablePointId("transcript", "abc", 0)).not.toBe(stablePointId("transcript", "abc", 1));
    expect(stablePointId("metadata", "abc")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("mergeCatalog", () => {
  test("keeps cached enrichment while making fresh ordering authoritative", () => {
    const cached = [{ id: "a", title: "Old", url: "old", index: 1, speaker: "Speaker" }];
    const fresh = [
      { id: "b", title: "New", url: "new", index: 1 },
      { id: "a", title: "Updated", url: "updated", index: 2 },
    ];
    expect(mergeCatalog(fresh, cached)).toEqual([
      { id: "b", title: "New", url: "new", index: 1 },
      { id: "a", title: "Updated", url: "updated", index: 2, speaker: "Speaker" },
    ]);
  });
});

describe("parseTranscriptProviderOutput", () => {
  test("preserves structured provider failures", () => {
    expect(parseTranscriptProviderOutput('{"status":"provider_blocked","errorType":"IpBlocked"}')).toEqual({
      status: "provider_blocked",
      errorType: "IpBlocked",
    });
  });

  test("converts malformed output into an explicit error", () => {
    expect(parseTranscriptProviderOutput("not-json").status).toBe("error");
  });
});

describe("extractFrontmatterUrl", () => {
  test("finds a YouTube URL in multi-field frontmatter", () => {
    const markdown = "---\ntitle: Example\nauthor: AI Engineer\nurl: https://www.youtube.com/watch?v=wEc9aG7cRQc\n---\n# Example";
    expect(extractFrontmatterUrl(markdown)).toBe("https://www.youtube.com/watch?v=wEc9aG7cRQc");
  });

  test("falls back to a transcript timestamp URL when saved markdown omits frontmatter", () => {
    const markdown = "# Example\n\n[0:02](https://youtube.com/watch?v=wEc9aG7cRQc&t=2s)\n\nTranscript";
    expect(extractYoutubeUrl(markdown)).toBe("https://www.youtube.com/watch?v=wEc9aG7cRQc");
  });
});
