/**
 * ZOU-1047 / ES-01 — Evidence-Readiness derivation (evidence-readiness/v1).
 *
 * Deterministic, pure, fail-closed. No I/O, no Qdrant, no mutation. Consumes a
 * VersionedRecord-shaped input and produces { readinessStage, validity, reasons }.
 *
 * Authority: phase-a-implementation-authority-2026-08-01.md (operator-approved 2026-08-02).
 * Contract: evaluations/zou-1047-contract-draft-2026-08-01.md and
 *           scripts/linear-plan.json -> planningControls.evidenceReadinessModel.
 */

export const CONTRACT_VERSION = "evidence-readiness/v1" as const;

export const EVIDENCE_FACTS = [
  "catalog_covered",
  "transcript_available",
  "chunk_ready",
  "evidence_sufficient",
] as const;
export type EvidenceFact = (typeof EVIDENCE_FACTS)[number];

export const READINESS_STAGES = [
  "catalog_only",
  "transcript_staged",
  "chunk_ready",
  "evidence_sufficient",
] as const;
export type ReadinessStage = (typeof READINESS_STAGES)[number];

export type Validity = "valid" | "invalid";

export interface EvidenceFacts {
  catalog_covered: boolean;
  transcript_available: boolean;
  chunk_ready: boolean;
  evidence_sufficient: boolean;
}

export interface SourceLineage {
  catalogPath: string | null;
  articlePath: string | null;
  qdrantCollection: string | null;
  sourceHash: string | null;
  processorVersion: string | null;
}

export interface VersionedRecord {
  contractVersion: string;
  videoId: string;
  evidenceFacts: Partial<Record<EvidenceFact, boolean>>;
  sourceLineage?: Partial<SourceLineage>;
  observedAt?: string;
  /** Optional declared stage from a producer; validated, never trusted blindly. */
  declaredReadinessStage?: string;
  /**
   * Catalog membership count for this videoId in the canonical catalog. When
   * supplied, a value other than exactly 1 is invalid (duplicate or absent
   * membership fails closed). Omit only when the caller cannot enumerate the
   * catalog; catalog_covered=true then asserts membership on the caller's word.
   */
  catalogMembershipCount?: number;
}

export interface DerivationResult {
  validity: Validity;
  /** Present only when validity === "valid". */
  readinessStage: ReadinessStage | null;
  /** Deterministic machine-readable reasons for the outcome (esp. invalid). */
  reasons: string[];
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Derive the single readiness stage from cumulative facts, failing closed on any
 * contradiction, unknown enum, missing lineage, stale hash, or duplicate membership.
 *
 * Precedence (highest satisfied fact wins):
 *   evidence_sufficient > chunk_ready > transcript_available > catalog_covered
 */
export function deriveReadiness(rec: VersionedRecord): DerivationResult {
  const reasons: string[] = [];

  // --- Contract version gate -------------------------------------------------
  if (rec.contractVersion !== CONTRACT_VERSION) {
    reasons.push(`unknown_contract_version:${JSON.stringify(rec.contractVersion)}`);
  }

  // --- videoId shape (11-char YouTube id) ------------------------------------
  if (!isNonEmptyString(rec.videoId) || rec.videoId.length !== 11) {
    reasons.push(`invalid_video_id:${JSON.stringify(rec.videoId)}`);
  }

  // --- Fact enum validation: reject unknown / non-boolean facts ---------------
  const facts = rec.evidenceFacts ?? {};
  for (const key of Object.keys(facts)) {
    if (!EVIDENCE_FACTS.includes(key as EvidenceFact)) {
      reasons.push(`unknown_fact:${key}`);
    }
  }
  for (const f of EVIDENCE_FACTS) {
    const v = facts[f];
    if (v !== undefined && typeof v !== "boolean") {
      reasons.push(`non_boolean_fact:${f}`);
    }
  }

  const catalog = facts.catalog_covered === true;
  const transcript = facts.transcript_available === true;
  const chunk = facts.chunk_ready === true;
  const sufficient = facts.evidence_sufficient === true;

  // --- catalog_covered is the floor: absent/false => invalid -------------------
  if (!catalog) {
    reasons.push("catalog_covered_absent_or_false");
  }

  // --- Duplicate / absent catalog membership (when enumerable) -----------------
  if (rec.catalogMembershipCount !== undefined) {
    if (rec.catalogMembershipCount > 1) {
      reasons.push(`duplicate_catalog_membership:${rec.catalogMembershipCount}`);
    } else if (rec.catalogMembershipCount === 0 && catalog) {
      reasons.push("contradiction:catalog_covered_with_zero_membership");
    }
  }

  // --- Implication contradictions (cumulative, not exclusive) -----------------
  // chunk_ready => transcript_available && catalog_covered
  if (chunk && !transcript) reasons.push("contradiction:chunk_ready_without_transcript_available");
  if (chunk && !catalog) reasons.push("contradiction:chunk_ready_without_catalog_covered");
  // evidence_sufficient => chunk_ready
  if (sufficient && !chunk) reasons.push("contradiction:evidence_sufficient_without_chunk_ready");
  // transcript_available => catalog_covered
  if (transcript && !catalog) reasons.push("contradiction:transcript_available_without_catalog_covered");

  // --- Lineage validation ------------------------------------------------------
  const lin = rec.sourceLineage ?? {};
  if (chunk || sufficient) {
    // Chunk-level facts require full lineage: a real source hash + processor version.
    if (!isNonEmptyString(lin.sourceHash) || !SHA256_RE.test(lin.sourceHash)) {
      reasons.push("stale_or_missing_source_hash");
    }
    if (!isNonEmptyString(lin.processorVersion)) {
      reasons.push("missing_processor_version");
    }
    if (!isNonEmptyString(lin.qdrantCollection)) {
      reasons.push("missing_qdrant_collection");
    }
  }
  if (transcript && !isNonEmptyString(lin.articlePath)) {
    reasons.push("transcript_available_without_article_path");
  }
  if (catalog && !isNonEmptyString(lin.catalogPath)) {
    reasons.push("catalog_covered_without_catalog_path");
  }

  // --- Declared stage (if present) must be a known enum and match derivation ---
  if (rec.declaredReadinessStage !== undefined) {
    if (!READINESS_STAGES.includes(rec.declaredReadinessStage as ReadinessStage)) {
      reasons.push(`unknown_declared_stage:${JSON.stringify(rec.declaredReadinessStage)}`);
    }
  }

  if (reasons.length > 0) {
    return { validity: "invalid", readinessStage: null, reasons };
  }

  // --- Derivation: highest satisfied fact --------------------------------------
  let stage: ReadinessStage;
  if (sufficient) stage = "evidence_sufficient";
  else if (chunk) stage = "chunk_ready";
  else if (transcript) stage = "transcript_staged";
  else stage = "catalog_only";

  // Cross-check a declared stage if one was supplied.
  if (
    rec.declaredReadinessStage !== undefined &&
    rec.declaredReadinessStage !== stage
  ) {
    return {
      validity: "invalid",
      readinessStage: null,
      reasons: [
        `declared_stage_mismatch:declared=${rec.declaredReadinessStage}:derived=${stage}`,
      ],
    };
  }

  return { validity: "valid", readinessStage: stage, reasons: [] };
}

/** Derive the stage for a batch, partitioning into valid rollups and invalid records. */
export function deriveBatch(records: VersionedRecord[]): {
  valid: Array<{ videoId: string; readinessStage: ReadinessStage }>;
  invalid: Array<{ videoId: string; reasons: string[] }>;
  rollup: Record<ReadinessStage, number>;
} {
  const valid: Array<{ videoId: string; readinessStage: ReadinessStage }> = [];
  const invalid: Array<{ videoId: string; reasons: string[] }> = [];
  const rollup: Record<ReadinessStage, number> = {
    catalog_only: 0,
    transcript_staged: 0,
    chunk_ready: 0,
    evidence_sufficient: 0,
  };
  for (const rec of records) {
    const r = deriveReadiness(rec);
    if (r.validity === "valid" && r.readinessStage) {
      valid.push({ videoId: rec.videoId, readinessStage: r.readinessStage });
      rollup[r.readinessStage] += 1;
    } else {
      invalid.push({ videoId: rec.videoId, reasons: r.reasons });
    }
  }
  return { valid, invalid, rollup };
}
