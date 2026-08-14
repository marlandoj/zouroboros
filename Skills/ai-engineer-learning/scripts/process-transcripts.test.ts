import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROCESSOR_VERSION,
  buildChunkPayload,
  loadCohortManifest,
  parseProcessorOptions,
  shouldProcess,
} from "./process-transcripts";
import { readinessForHit } from "./evidence-readiness";

describe("parseProcessorOptions", () => {
  test("preserves the default unscoped behavior", () => {
    expect(parseProcessorOptions([])).toEqual({
      batchSize: Infinity,
      dryRun: false,
      limit: Infinity,
      rebuild: false,
      cohortManifest: undefined,
    });
  });

  test("requires rebuild and cohort manifest together", () => {
    expect(() => parseProcessorOptions(["--rebuild"])).toThrow();
    expect(() => parseProcessorOptions(["--cohort-manifest=/tmp/manifest.json"])).toThrow();
    expect(parseProcessorOptions([
      "--rebuild",
      "--cohort-manifest=/tmp/manifest.json",
      "--dry-run",
    ])).toMatchObject({
      rebuild: true,
      cohortManifest: "/tmp/manifest.json",
      dryRun: true,
    });
  });
});

describe("loadCohortManifest", () => {
  test("selects only unique canonical Article IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-engineer-cohort-"));
    const path = join(directory, "manifest.json");
    try {
      writeFileSync(path, JSON.stringify({
        items: [
          { video_id: "AQv3qRCG6Gw", artifact_state: "canonical_article", article_hash: "abc" },
          { video_id: "jWq-aZIU0kM", artifact_state: "unavailable", article_hash: null },
        ],
      }));
      expect([...loadCohortManifest(path).keys()]).toEqual(["AQv3qRCG6Gw"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("shouldProcess", () => {
  const state = {
    processed: {
      AQv3qRCG6Gw: { hash: "same", chunks: 14, timestamp: "2026-07-31T00:00:00Z" },
      untouched123: { hash: "same", chunks: 3, timestamp: "2026-07-31T00:00:00Z" },
    },
  };

  test("bypasses a matching hash only for a requested rebuild ID", () => {
    const requested = new Set(["AQv3qRCG6Gw"]);
    expect(shouldProcess("AQv3qRCG6Gw", "same", state, requested)).toBe(true);
    expect(shouldProcess("untouched123", "same", state, requested)).toBe(false);
    expect(shouldProcess("untouched123", "changed", state, requested)).toBe(true);
  });
});

// ZOU-1291 AC4: the upsert payload must reach readinessForHit stage=transcript_staged
// once lineage fields are present, and must still fail closed when article_path is absent.
describe("buildChunkPayload lineage fields (ZOU-1291 AC3/AC4)", () => {
  const validSourceHash = "a".repeat(64);

  test("gains has_transcript, article_path, source_hash, processor_version", () => {
    const payload = buildChunkPayload({
      videoId: "abcdefghijk",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      chunkIndex: 0,
      chunkTotal: 1,
      content: "hello world",
      articlePath: "Articles/example :: www.youtube.com.md",
      sourceHash: validSourceHash,
    });
    expect(payload).toMatchObject({
      has_transcript: true,
      article_path: "Articles/example :: www.youtube.com.md",
      source_hash: validSourceHash,
      processor_version: PROCESSOR_VERSION,
    });
    // Unchanged fields from the pre-ZOU-1291 payload shape.
    expect(payload).toMatchObject({
      video_id: "abcdefghijk",
      chunk_index: 0,
      chunk_total: 1,
      content: "hello world",
    });
  });

  test("a patched payload reaches readinessForHit stage=transcript_staged/valid", () => {
    const payload = buildChunkPayload({
      videoId: "abcdefghijk",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      chunkIndex: 0,
      chunkTotal: 1,
      content: "hello world",
      articlePath: "Articles/example :: www.youtube.com.md",
      sourceHash: validSourceHash,
    });
    const readiness = readinessForHit({ id: 1, payload }, "transcript_staged");
    expect(readiness.validity).toBe("valid");
    expect(readiness.stage).toBe("transcript_staged");
    expect(readiness.meetsThreshold).toBe(true);
    expect(readiness.provenance.articlePath).toBe("Articles/example :: www.youtube.com.md");
  });

  test("a payload missing article_path still fails closed", () => {
    const payload = buildChunkPayload({
      videoId: "abcdefghijk",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      chunkIndex: 0,
      chunkTotal: 1,
      content: "hello world",
      articlePath: "Articles/example :: www.youtube.com.md",
      sourceHash: validSourceHash,
    });
    delete (payload as Record<string, unknown>).article_path;
    const readiness = readinessForHit({ id: 1, payload }, "transcript_staged");
    expect(readiness.validity).toBe("invalid");
    expect(readiness.stage).toBe("invalid");
    expect(readiness.reasons).toContain("transcript_available_without_article_path");
  });

  test("source_hash must satisfy the contract's 64-hex SHA256_RE, not the 16-char change-detection hash", () => {
    const shortHashPayload = buildChunkPayload({
      videoId: "abcdefghijk",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      chunkIndex: 0,
      chunkTotal: 1,
      content: "hello world",
      articlePath: "Articles/example :: www.youtube.com.md",
      sourceHash: "0123456789abcdef", // 16-char change-detection hash, deliberately wrong length
    }) as Record<string, unknown>;
    // chunk_ready/evidence_sufficient are hit-level facts the writer does not set
    // (this seed only claims transcript_staged); force them on to exercise the
    // lineage-hash branch of deriveReadiness directly, proving a 16-char hash
    // fails the same SHA256_RE the writer must satisfy for source_hash.
    shortHashPayload.chunk_ready = true;
    const readiness = readinessForHit({ id: 1, payload: shortHashPayload }, "chunk_ready");
    expect(readiness.validity).toBe("invalid");
    expect(readiness.reasons).toContain("stale_or_missing_source_hash");

    const fullHashPayload = buildChunkPayload({
      videoId: "abcdefghijk",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      chunkIndex: 0,
      chunkTotal: 1,
      content: "hello world",
      articlePath: "Articles/example :: www.youtube.com.md",
      sourceHash: validSourceHash,
    }) as Record<string, unknown>;
    fullHashPayload.chunk_ready = true;
    const readinessFull = readinessForHit({ id: 1, payload: fullHashPayload }, "chunk_ready");
    expect(readinessFull.reasons).not.toContain("stale_or_missing_source_hash");
  });
});
