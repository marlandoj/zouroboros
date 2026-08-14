import {
  CONTRACT_VERSION,
  READINESS_STAGES,
  deriveReadiness,
  type ReadinessStage,
  type VersionedRecord,
} from "./evidence-readiness-contract";

export { CONTRACT_VERSION as EVIDENCE_READINESS_CONTRACT, READINESS_STAGES };
export type { ReadinessStage };

export type EvidenceGateMode = "off" | "annotate";

export interface EvidenceGateConfig {
  mode: EvidenceGateMode;
  minTier: ReadinessStage;
}

export interface RetrievalHit {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

export interface EvidenceReadinessAnnotation {
  contractVersion: typeof CONTRACT_VERSION;
  stage: ReadinessStage | "invalid";
  validity: "valid" | "invalid";
  meetsThreshold: boolean;
  reasons: string[];
  provenance: {
    collection: "ai-engineer-videos";
    videoId: string | null;
    transcriptBacked: boolean;
    articlePath: string | null;
    sourceHash: string | null;
    processorVersion: string | null;
  };
}

export type AnnotatedHit<T extends RetrievalHit> = T & { readiness: EvidenceReadinessAnnotation };

export function formatEvidenceReadinessLines<T extends RetrievalHit>(
  hits: Array<AnnotatedHit<T>>,
  minTier: ReadinessStage,
): string {
  return hits
    .map((hit, index) => {
      const readiness = hit.readiness;
      const provenance = readiness.provenance;
      return `  - Hit ${index + 1}: stage=${readiness.stage}; meets_${minTier}=${readiness.meetsThreshold ? "yes" : "no"}; collection=${provenance.collection}; video=${provenance.videoId ?? "unknown"}; transcript_backed=${provenance.transcriptBacked ? "yes" : "no"}; article=${provenance.articlePath ?? "unavailable"}`;
    })
    .join("\n");
}

export interface EvidenceGateResult<T extends RetrievalHit> {
  mode: EvidenceGateMode;
  minTier: ReadinessStage;
  hits: Array<T | AnnotatedHit<T>>;
  cohort: {
    total: number;
    byStage: Record<ReadinessStage | "invalid", number>;
    meetingThreshold: number;
    meetingThresholdRatio: number;
  };
  synthesis: {
    permitted: true;
    labeled: boolean;
    reason: string;
  };
}

const STAGE_INDEX = new Map<ReadinessStage, number>(READINESS_STAGES.map((stage, index) => [stage, index]));

function parseTier(raw: string | undefined): ReadinessStage {
  const normalized = (raw ?? "transcript_staged").toLowerCase();
  if (!READINESS_STAGES.includes(normalized as ReadinessStage)) {
    throw new Error(`invalid EVIDENCE_GATE_MIN_TIER: ${raw}`);
  }
  return normalized as ReadinessStage;
}

export function evidenceGateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EvidenceGateConfig {
  const rawMode = (env.EVIDENCE_GATE_MODE ?? "off").toLowerCase();
  if (rawMode === "enforce") {
    throw new Error("EVIDENCE_GATE_MODE=enforce is not authorized during ZOU-1049 preparation");
  }
  if (rawMode !== "off" && rawMode !== "annotate") {
    throw new Error(`invalid EVIDENCE_GATE_MODE: ${env.EVIDENCE_GATE_MODE}`);
  }
  return { mode: rawMode, minTier: parseTier(env.EVIDENCE_GATE_MIN_TIER) };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readinessRecordForHit(hit: RetrievalHit): VersionedRecord {
  const payload = hit.payload ?? {};
  const videoId = stringValue(payload.video_id) ?? stringValue(payload.source);
  const content = stringValue(payload.content);
  const chunkIndex = integerValue(payload.chunk_index);
  const chunkTotal = integerValue(payload.chunk_total);
  const explicitlyMetadataOnly = payload.has_transcript === false;
  const transcriptAvailable =
    !explicitlyMetadataOnly &&
    (payload.has_transcript === true || Boolean(content && chunkIndex !== null && chunkTotal !== null));
  const articlePath = transcriptAvailable ? stringValue(payload.article_path) : null;

  return {
    contractVersion: CONTRACT_VERSION,
    videoId: videoId ?? "",
    evidenceFacts: {
      catalog_covered: videoId !== null,
      transcript_available: transcriptAvailable,
      chunk_ready: payload.chunk_ready === true,
      evidence_sufficient: payload.evidence_sufficient === true,
    },
    sourceLineage: {
      catalogPath: videoId ? "Projects/ai-engineer-learning/channel-videos.json" : null,
      articlePath,
      qdrantCollection: "ai-engineer-videos",
      sourceHash: stringValue(payload.source_hash),
      processorVersion: stringValue(payload.processor_version),
    },
  };
}

export function readinessForHit(hit: RetrievalHit, minTier: ReadinessStage): EvidenceReadinessAnnotation {
  const record = readinessRecordForHit(hit);
  const derived = deriveReadiness(record);
  const stage = derived.validity === "valid" && derived.readinessStage ? derived.readinessStage : "invalid";
  const stageIndex = stage === "invalid" ? -1 : STAGE_INDEX.get(stage) ?? -1;
  const thresholdIndex = STAGE_INDEX.get(minTier) ?? Number.POSITIVE_INFINITY;
  const lineage = record.sourceLineage ?? {};

  return {
    contractVersion: CONTRACT_VERSION,
    stage,
    validity: derived.validity,
    meetsThreshold: stageIndex >= thresholdIndex,
    reasons: derived.reasons,
    provenance: {
      collection: "ai-engineer-videos",
      videoId: record.videoId || null,
      transcriptBacked: stageIndex >= (STAGE_INDEX.get("transcript_staged") ?? Number.POSITIVE_INFINITY),
      articlePath: lineage.articlePath ?? null,
      sourceHash: lineage.sourceHash ?? null,
      processorVersion: lineage.processorVersion ?? null,
    },
  };
}

function stageCounts(): Record<ReadinessStage | "invalid", number> {
  return { catalog_only: 0, transcript_staged: 0, chunk_ready: 0, evidence_sufficient: 0, invalid: 0 };
}

export function applyEvidenceReadinessGate<T extends RetrievalHit>(
  hits: T[],
  config: EvidenceGateConfig,
): EvidenceGateResult<T> {
  if (config.mode === "off") {
    return {
      mode: "off",
      minTier: config.minTier,
      hits,
      cohort: { total: hits.length, byStage: stageCounts(), meetingThreshold: 0, meetingThresholdRatio: 0 },
      synthesis: { permitted: true, labeled: false, reason: "gate off; production results unchanged" },
    };
  }

  const byStage = stageCounts();
  let meetingThreshold = 0;
  const annotated = hits.map((hit) => {
    const readiness = readinessForHit(hit, config.minTier);
    byStage[readiness.stage] += 1;
    if (readiness.meetsThreshold) meetingThreshold += 1;
    return { ...hit, readiness };
  });
  const total = annotated.length;
  const meetingThresholdRatio = total === 0 ? 0 : meetingThreshold / total;
  const labeled = meetingThresholdRatio < 1;

  return {
    mode: "annotate",
    minTier: config.minTier,
    hits: annotated,
    cohort: { total, byStage, meetingThreshold, meetingThresholdRatio },
    synthesis: {
      permitted: true,
      labeled,
      reason: labeled
        ? `shadow annotation: ${meetingThreshold}/${total} hits meet ${config.minTier}; enforcement unavailable`
        : `all ${total} hits meet ${config.minTier}; shadow annotation only`,
    },
  };
}
