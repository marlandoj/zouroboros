import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyEvidenceReadinessGate,
  evidenceGateConfigFromEnv,
  formatEvidenceReadinessLines,
  readinessRecordForHit,
  readinessForHit,
  type RetrievalHit,
} from "./evidence-readiness";
import { deriveReadiness } from "./evidence-readiness-contract";
import { applyQueryEvidenceReadiness } from "./query";

const metadataHit: RetrievalHit = {
  id: "m1",
  score: 0.8,
  payload: {
    video_id: "abcdefghijk",
    title: "Metadata",
    content: "Title: Metadata\nDuration: 10:00\nURL: https://example.test",
    chunk_index: 0,
    chunk_total: 1,
    has_transcript: false,
  },
};
const transcriptHit: RetrievalHit = {
  id: "t1",
  score: 0.9,
  payload: {
    video_id: "lmnopqrstuv",
    content: "Transcript-backed evidence",
    chunk_index: 0,
    chunk_total: 2,
    article_path: "Articles/lmnopqrstuv :: www.youtube.com.md",
  },
};

describe("evidence readiness production gate", () => {
  test("defaults to inert off mode", () => {
    expect(evidenceGateConfigFromEnv({})).toEqual({ mode: "off", minTier: "transcript_staged" });
  });

  test("off mode returns the original array and bytes unchanged", () => {
    const hits = [metadataHit, transcriptHit];
    const before = JSON.stringify(hits);
    const result = applyEvidenceReadinessGate(hits, { mode: "off", minTier: "transcript_staged" });
    expect(result.hits).toBe(hits);
    expect(JSON.stringify(result.hits)).toBe(before);
  });

  test("annotates catalog and transcript stages without changing order", () => {
    const result = applyEvidenceReadinessGate([metadataHit, transcriptHit], {
      mode: "annotate",
      minTier: "transcript_staged",
    });
    expect(result.hits.map((hit) => hit.id)).toEqual(["m1", "t1"]);
    expect((result.hits[0] as any).readiness.stage).toBe("catalog_only");
    expect((result.hits[1] as any).readiness.stage).toBe("transcript_staged");
    expect(result.cohort).toMatchObject({ total: 2, meetingThreshold: 1, meetingThresholdRatio: 0.5 });
    expect(result.synthesis).toMatchObject({ permitted: true, labeled: true });
  });

  test("honors the metadata producer's has_transcript=false marker", () => {
    const readiness = readinessForHit(metadataHit, "transcript_staged");
    expect(readiness).toMatchObject({ stage: "catalog_only", validity: "valid", meetsThreshold: false });
    expect(readiness.provenance.transcriptBacked).toBe(false);
  });

  test("uses the approved canonical derivation", () => {
    const record = readinessRecordForHit(transcriptHit);
    const canonical = deriveReadiness(record);
    expect(canonical).toMatchObject({ validity: "valid", readinessStage: "transcript_staged" });
    expect(readinessForHit(transcriptHit, "transcript_staged").stage).toBe(canonical.readinessStage ?? "invalid");
  });

  test("does not invent missing transcript lineage", () => {
    const currentProducerShape: RetrievalHit = {
      id: "unlined",
      payload: { video_id: "lmnopqrstuv", content: "Transcript chunk", chunk_index: 0, chunk_total: 2 },
    };
    const readiness = readinessForHit(currentProducerShape, "transcript_staged");
    expect(readiness.stage).toBe("invalid");
    expect(readiness.reasons).toContain("transcript_available_without_article_path");
    expect(readiness.provenance.articlePath).toBeNull();
  });

  test("requires complete lineage before accepting chunk readiness", () => {
    const invalid = readinessForHit(
      { id: "c1", payload: { video_id: "abcdefghijk", content: "chunk", chunk_ready: true } },
      "chunk_ready",
    );
    expect(invalid.stage).toBe("invalid");
    expect(invalid.reasons).toContain("contradiction:chunk_ready_without_transcript_available");
    expect(invalid.reasons).toContain("stale_or_missing_source_hash");

    const valid = readinessForHit(
      {
        id: "c2",
        payload: {
          video_id: "abcdefghijk",
          content: "chunk",
          chunk_ready: true,
          chunk_index: 0,
          chunk_total: 2,
          source_hash: "a".repeat(64),
          processor_version: "process-transcripts/v1",
          article_path: "Articles/abcdefghijk :: www.youtube.com.md",
        },
      },
      "chunk_ready",
    );
    expect(valid).toMatchObject({ stage: "chunk_ready", meetsThreshold: true, reasons: [] });
  });

  test("fails closed on missing identity and contradictory sufficiency", () => {
    expect(readinessForHit({ id: "bad", payload: { content: "orphan" } }, "catalog_only")).toMatchObject({
      stage: "invalid",
      meetsThreshold: false,
    });
    expect(
      readinessForHit(
        { id: "bad2", payload: { video_id: "abcdefghijk", content: "text", evidence_sufficient: true } },
        "transcript_staged",
      ).reasons,
    ).toContain("contradiction:evidence_sufficient_without_chunk_ready");
  });

  test("rejects enforcement and malformed configuration", () => {
    expect(() => evidenceGateConfigFromEnv({ EVIDENCE_GATE_MODE: "enforce" })).toThrow("not authorized");
    expect(() => evidenceGateConfigFromEnv({ EVIDENCE_GATE_MODE: "typo" })).toThrow("invalid EVIDENCE_GATE_MODE");
    expect(() => evidenceGateConfigFromEnv({ EVIDENCE_GATE_MIN_TIER: "unknown" })).toThrow(
      "invalid EVIDENCE_GATE_MIN_TIER",
    );
  });

  test("production query imports and invokes the canonical gate", () => {
    const source = readFileSync(join(import.meta.dir, "query.ts"), "utf8");
    expect(source).toContain('from "./evidence-readiness"');
    expect(source).toContain("applyEvidenceReadinessGate(results, evidenceGateConfigFromEnv(env))");
    expect(source).toContain("applyQueryEvidenceReadiness(results)");
    expect(source).toContain("formatEvidenceReadinessLines(group.chunks, evidenceGate.minTier)");
  });

  test("exports the exact production query adapter for parity evaluation", () => {
    const hits = [metadataHit, transcriptHit];
    const result = applyQueryEvidenceReadiness(hits, {
      EVIDENCE_GATE_MODE: "annotate",
      EVIDENCE_GATE_MIN_TIER: "transcript_staged",
    });
    expect(result.hits.map((hit) => hit.id)).toEqual(["m1", "t1"]);
    expect(result.cohort).toMatchObject({ total: 2, meetingThreshold: 1 });
  });

  test("renders readiness and provenance for every same-video hit", () => {
    const result = applyEvidenceReadinessGate(
      [
        transcriptHit,
        { ...transcriptHit, id: "t2", payload: { ...transcriptHit.payload, chunk_index: 1 } },
      ],
      { mode: "annotate", minTier: "transcript_staged" },
    );
    const rendered = formatEvidenceReadinessLines(result.hits as any, result.minTier);
    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).toContain("Hit 1: stage=transcript_staged");
    expect(rendered).toContain("Hit 2: stage=transcript_staged");
    expect(rendered.match(/collection=ai-engineer-videos/g)).toHaveLength(2);
  });
});
