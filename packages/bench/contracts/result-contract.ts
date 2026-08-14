/**
 * ZouroBench Results Explorer — versioned result contract (ZBRE-001 / ZOU-829).
 *
 * Single typed contract the explorer consumes. Historical artifacts are never
 * rewritten: v1 artifacts (no `schema_version`) and v2 artifacts
 * (`schema_version: 2`) both normalize into one read model.
 *
 * Honesty rule: metadata a legacy artifact never recorded stays unknown.
 * Unverifiable fields normalize to `{ value: null, availability_reason }` —
 * never to zero, false, or a passing verdict.
 */

// ─── Availability-preserving fields ──────────────────────────────────

/**
 * A field whose evidence may be missing. `availability_reason` is non-null
 * exactly when `value` is null.
 */
export interface Evidenced<T> {
  value: T | null;
  availability_reason: string | null;
}

export function present<T>(value: T): Evidenced<T> {
  return { value, availability_reason: null };
}

export function unavailable<T>(reason: string): Evidenced<T> {
  return { value: null, availability_reason: reason };
}

/** Canonical availability reasons for fields legacy artifacts never recorded. */
export const UNAVAILABLE_REASONS = {
  v1NoRunId: "v1 artifact does not record a run identifier",
  v1NoCohort: "v1 artifact predates replicate cohort metadata",
  v1NoProvenance: "v1 artifact does not record provenance",
  v1NoExecution:
    "v1 artifact does not record execution metadata (models and timeouts were env-configured and unlogged)",
  v1NoUsage: "v1 artifact does not record token usage",
  v1NoPricing: "v1 artifact does not record pricing",
  v1NoParity: "v1 artifact does not record parity evidence",
  v1QuestionFieldAbsent: (field: string) =>
    `v1 artifact omits ${field} unless explicitly recorded; absence is ambiguous, not false`,
  gateDisabled: "consensus gate was disabled for this run",
  gateEvidenceAbsent: "consensus gate evidence not recorded for this question",
} as const;

// ─── Structured errors ───────────────────────────────────────────────

export type ContractIssueCode =
  | "not_object"
  | "foreign_schema"
  | "unsupported_version"
  | "missing_field"
  | "wrong_type"
  | "invalid_value";

export interface ContractIssue {
  path: string;
  code: ContractIssueCode;
  message: string;
}

// ─── Shared score / latency shapes (identical in v1 and v2) ──────────

export interface ScoreCell {
  correct: number;
  total: number;
  accuracy: number;
}

export interface ScoresBlock {
  overall_accuracy: number;
  by_category: Record<string, ScoreCell>;
  by_type: Record<string, ScoreCell>;
}

export interface LatencyBlock {
  avg_retrieval_ms: number;
  avg_answer_ms: number;
  p95_retrieval_ms: number;
}

// ─── v2 artifact shapes ──────────────────────────────────────────────

export interface RunIdentityV2 {
  run_id: string;
  benchmark: string;
  timestamp: string;
  dataset: string;
}

export interface CohortV2 {
  cohort_id: string;
  replicate_index: number;
  replicate_seed: number;
  minimum_n: number;
  timeout_ms: number | null;
}

/** Base fields are required; current-producer extensions stay optional for older valid v2 artifacts. */
export interface ProvenanceV2 {
  produced_by: string;
  adapter_version: string;
  git_commit: string;
  git_dirty?: boolean;
  host: string;
  invocation: string;
  dataset_sha256?: string;
  question_set_sha256?: string;
  config_fingerprint: string;
  recorded_at: string;
}

export interface ExecutionV2 {
  answer_model: string;
  judge_model: Evidenced<string>;
  embedding_model: Evidenced<string>;
  truncation_guard_enabled: boolean;
  generation_timeout_ms: Evidenced<number>;
}

export interface UsageV2 {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface PricingV2 {
  currency: string;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  source: string;
}

export interface ConsensusV2 {
  enabled: boolean;
  threshold: Evidenced<number>;
  invocations: Evidenced<number>;
  splits: Evidenced<number>;
}

export interface ParityV2 {
  baseline_run_id: string;
  baseline_overall_accuracy: number;
  delta_overall_accuracy: number;
  paired_questions: number;
}

export interface RunErrorV2 {
  question_id: string | null;
  stage: string;
  message: string;
}

export interface QuestionV2 {
  question_id: string;
  question_type: string;
  category: string;
  question: string;
  ground_truth: string;
  hypothesis: string;
  retrieved_context?: string[];
  retrieval_ms: number;
  answer_ms: number;
  correct: boolean;
  judge_label?: string;
  judge_confidence?: number;
  consensus_invoked?: boolean;
  consensus_verdict?: string;
  consensus_confidence?: number;
  truncated?: boolean;
  timed_out?: boolean;
  usage?: Evidenced<UsageV2>;
}

export interface ResultArtifactV2 {
  schema_version: 2;
  run: RunIdentityV2;
  cohort: CohortV2;
  provenance: ProvenanceV2;
  execution: ExecutionV2;
  totals: { total_questions: number; answered: number };
  scores: ScoresBlock;
  latency: LatencyBlock;
  usage: Evidenced<UsageV2>;
  pricing: Evidenced<PricingV2>;
  consensus: ConsensusV2;
  parity: Evidenced<ParityV2>;
  errors: RunErrorV2[];
  questions: QuestionV2[];
}

// ─── Normalized read model ───────────────────────────────────────────

export interface NormalizedQuestion {
  question_id: string;
  question_type: string;
  category: string;
  question: string;
  ground_truth: string;
  hypothesis: string;
  retrieved_context: string[] | null;
  retrieval_ms: number;
  answer_ms: number;
  correct: boolean;
  judge_label: Evidenced<string>;
  judge_confidence: Evidenced<number>;
  consensus_invoked: Evidenced<boolean>;
  consensus_verdict: Evidenced<string>;
  consensus_confidence: Evidenced<number>;
  truncated: Evidenced<boolean>;
  timed_out: Evidenced<boolean>;
  usage: Evidenced<UsageV2>;
}

export interface NormalizedRun {
  schema_version: 1 | 2;
  run_id: Evidenced<string>;
  benchmark: string;
  timestamp: string;
  dataset: string;
  totals: { total_questions: number; answered: number };
  scores: ScoresBlock;
  latency: LatencyBlock;
  cohort: Evidenced<CohortV2>;
  provenance: Evidenced<ProvenanceV2>;
  execution: Evidenced<ExecutionV2>;
  usage: Evidenced<UsageV2>;
  pricing: Evidenced<PricingV2>;
  consensus: ConsensusV2;
  parity: Evidenced<ParityV2>;
  errors: RunErrorV2[];
  questions: NormalizedQuestion[];
}

export type NormalizeResult =
  | { ok: true; run: NormalizedRun; warnings: ContractIssue[] }
  | { ok: false; errors: ContractIssue[] };

// ─── Version detection ───────────────────────────────────────────────

export type DetectedVersion =
  | { version: 1 | 2; issue: null }
  | { version: null; issue: ContractIssue };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * v2 declares `schema_version: 2`. v1 artifacts predate versioning: they are
 * recognized by the ZouroBench producer signature, never by guessing.
 */
export function detectArtifactVersion(raw: unknown): DetectedVersion {
  if (!isPlainObject(raw)) {
    return {
      version: null,
      issue: { path: "$", code: "not_object", message: "artifact is not a JSON object" },
    };
  }
  if ("schema_version" in raw) {
    if (raw.schema_version === 2) return { version: 2, issue: null };
    return {
      version: null,
      issue: {
        path: "$.schema_version",
        code: "unsupported_version",
        message: `unsupported schema_version ${JSON.stringify(raw.schema_version)}; expected 2 (or absent for legacy v1)`,
      },
    };
  }
  const looksV1 =
    raw.benchmark === "ZouroBench" &&
    isPlainObject(raw.scores) &&
    Array.isArray(raw.questions);
  if (looksV1) return { version: 1, issue: null };
  return {
    version: null,
    issue: {
      path: "$",
      code: "foreign_schema",
      message:
        "artifact has no schema_version and does not match the legacy ZouroBench v1 producer signature",
    },
  };
}

// ─── Validation helpers ──────────────────────────────────────────────

class IssueCollector {
  issues: ContractIssue[] = [];
  add(path: string, code: ContractIssueCode, message: string): void {
    this.issues.push({ path, code, message });
  }
}

function reqString(obj: Record<string, unknown>, path: string, key: string, c: IssueCollector): string | undefined {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (v === undefined) c.add(`${path}.${key}`, "missing_field", `required string field is missing`);
  else c.add(`${path}.${key}`, "wrong_type", `expected non-empty string, got ${JSON.stringify(v)?.slice(0, 60)}`);
  return undefined;
}

function reqNumber(obj: Record<string, unknown>, path: string, key: string, c: IssueCollector): number | undefined {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v === undefined) c.add(`${path}.${key}`, "missing_field", `required number field is missing`);
  else c.add(`${path}.${key}`, "wrong_type", `expected finite number, got ${JSON.stringify(v)?.slice(0, 60)}`);
  return undefined;
}

function reqBoolean(obj: Record<string, unknown>, path: string, key: string, c: IssueCollector): boolean | undefined {
  const v = obj[key];
  if (typeof v === "boolean") return v;
  if (v === undefined) c.add(`${path}.${key}`, "missing_field", `required boolean field is missing`);
  else c.add(`${path}.${key}`, "wrong_type", `expected boolean, got ${JSON.stringify(v)?.slice(0, 60)}`);
  return undefined;
}

function reqObject(obj: Record<string, unknown>, path: string, key: string, c: IssueCollector): Record<string, unknown> | undefined {
  const v = obj[key];
  if (isPlainObject(v)) return v;
  if (v === undefined) c.add(`${path}.${key}`, "missing_field", `required object field is missing`);
  else c.add(`${path}.${key}`, "wrong_type", `expected object, got ${JSON.stringify(v)?.slice(0, 60)}`);
  return undefined;
}

/** Validate an `Evidenced<T>` envelope; `checkValue` validates a non-null value. */
function readEvidenced<T>(
  raw: unknown,
  path: string,
  c: IssueCollector,
  checkValue: (v: unknown, path: string, c: IssueCollector) => T | undefined,
): Evidenced<T> | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected { value, availability_reason } envelope");
    return undefined;
  }
  const reason = raw.availability_reason;
  if (raw.value === null || raw.value === undefined) {
    if (typeof reason !== "string" || reason.length === 0) {
      c.add(
        `${path}.availability_reason`,
        "invalid_value",
        "a null value requires a non-empty availability_reason",
      );
      return undefined;
    }
    return unavailable<T>(reason);
  }
  if (reason !== null && reason !== undefined) {
    c.add(`${path}.availability_reason`, "invalid_value", "availability_reason must be null when value is present");
    return undefined;
  }
  const value = checkValue(raw.value, `${path}.value`, c);
  return value === undefined ? undefined : present(value);
}

function readScoreCell(raw: unknown, path: string, c: IssueCollector): ScoreCell | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected { correct, total, accuracy }");
    return undefined;
  }
  const correct = reqNumber(raw, path, "correct", c);
  const total = reqNumber(raw, path, "total", c);
  const accuracy = reqNumber(raw, path, "accuracy", c);
  if (correct === undefined || total === undefined || accuracy === undefined) return undefined;
  if (correct < 0 || total < 0 || correct > total) {
    c.add(path, "invalid_value", `inconsistent score cell: correct=${correct}, total=${total}`);
    return undefined;
  }
  return { correct, total, accuracy };
}

function readScores(raw: unknown, path: string, c: IssueCollector): ScoresBlock | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected scores object");
    return undefined;
  }
  let overall = reqNumber(raw, path, "overall_accuracy", c);
  if (overall !== undefined && (overall < 0 || overall > 100)) {
    c.add(`${path}.overall_accuracy`, "invalid_value", `accuracy out of range: ${overall}`);
    overall = undefined;
  }
  const readGroup = (key: "by_category" | "by_type"): Record<string, ScoreCell> | undefined => {
    const group = reqObject(raw, path, key, c);
    if (!group) return undefined;
    const out: Record<string, ScoreCell> = {};
    for (const [name, cell] of Object.entries(group)) {
      const parsed = readScoreCell(cell, `${path}.${key}.${name}`, c);
      if (!parsed) return undefined;
      out[name] = parsed;
    }
    return out;
  };
  const byCategory = readGroup("by_category");
  const byType = readGroup("by_type");
  if (overall === undefined || !byCategory || !byType) return undefined;
  return { overall_accuracy: overall, by_category: byCategory, by_type: byType };
}

function readLatency(raw: unknown, path: string, c: IssueCollector): LatencyBlock | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected latency object");
    return undefined;
  }
  const avgRetrieval = reqNumber(raw, path, "avg_retrieval_ms", c);
  const avgAnswer = reqNumber(raw, path, "avg_answer_ms", c);
  const p95 = reqNumber(raw, path, "p95_retrieval_ms", c);
  if (avgRetrieval === undefined || avgAnswer === undefined || p95 === undefined) return undefined;
  return { avg_retrieval_ms: avgRetrieval, avg_answer_ms: avgAnswer, p95_retrieval_ms: p95 };
}

function readUsage(raw: unknown, path: string, c: IssueCollector): UsageV2 | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected usage object");
    return undefined;
  }
  const prompt = reqNumber(raw, path, "prompt_tokens", c);
  const completion = reqNumber(raw, path, "completion_tokens", c);
  const total = reqNumber(raw, path, "total_tokens", c);
  if (prompt === undefined || completion === undefined || total === undefined) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function readPricing(raw: unknown, path: string, c: IssueCollector): PricingV2 | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected pricing object");
    return undefined;
  }
  const currency = reqString(raw, path, "currency", c);
  const input = reqNumber(raw, path, "input_cost", c);
  const output = reqNumber(raw, path, "output_cost", c);
  const total = reqNumber(raw, path, "total_cost", c);
  const source = reqString(raw, path, "source", c);
  if (currency === undefined || input === undefined || output === undefined || total === undefined || source === undefined) {
    return undefined;
  }
  return { currency, input_cost: input, output_cost: output, total_cost: total, source };
}

function readParity(raw: unknown, path: string, c: IssueCollector): ParityV2 | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected parity object");
    return undefined;
  }
  const baselineRunId = reqString(raw, path, "baseline_run_id", c);
  const baselineAccuracy = reqNumber(raw, path, "baseline_overall_accuracy", c);
  const delta = reqNumber(raw, path, "delta_overall_accuracy", c);
  const paired = reqNumber(raw, path, "paired_questions", c);
  if (baselineRunId === undefined || baselineAccuracy === undefined || delta === undefined || paired === undefined) {
    return undefined;
  }
  return {
    baseline_run_id: baselineRunId,
    baseline_overall_accuracy: baselineAccuracy,
    delta_overall_accuracy: delta,
    paired_questions: paired,
  };
}

function readProvenance(raw: unknown, path: string, c: IssueCollector): ProvenanceV2 | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected provenance object");
    return undefined;
  }
  const producedBy = reqString(raw, path, "produced_by", c);
  const adapterVersion = reqString(raw, path, "adapter_version", c);
  const gitCommit = reqString(raw, path, "git_commit", c);
  const host = reqString(raw, path, "host", c);
  const invocation = reqString(raw, path, "invocation", c);
  const fingerprint = reqString(raw, path, "config_fingerprint", c);
  const recordedAt = reqString(raw, path, "recorded_at", c);
  const optionalString = (key: "dataset_sha256" | "question_set_sha256"): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value === "string" && value.length > 0) return value;
    c.add(`${path}.${key}`, "wrong_type", "expected non-empty string when present");
    return undefined;
  };
  const datasetSha256 = optionalString("dataset_sha256");
  const questionSetSha256 = optionalString("question_set_sha256");
  let gitDirty: boolean | undefined;
  if (raw.git_dirty !== undefined) {
    if (typeof raw.git_dirty === "boolean") gitDirty = raw.git_dirty;
    else c.add(`${path}.git_dirty`, "wrong_type", "expected boolean when present");
  }
  if (
    producedBy === undefined || adapterVersion === undefined || gitCommit === undefined ||
    host === undefined || invocation === undefined || fingerprint === undefined || recordedAt === undefined ||
    (raw.dataset_sha256 !== undefined && datasetSha256 === undefined) ||
    (raw.question_set_sha256 !== undefined && questionSetSha256 === undefined) ||
    (raw.git_dirty !== undefined && gitDirty === undefined)
  ) {
    return undefined;
  }
  return {
    produced_by: producedBy,
    adapter_version: adapterVersion,
    git_commit: gitCommit,
    ...(gitDirty !== undefined ? { git_dirty: gitDirty } : {}),
    host,
    invocation,
    ...(datasetSha256 !== undefined ? { dataset_sha256: datasetSha256 } : {}),
    ...(questionSetSha256 !== undefined ? { question_set_sha256: questionSetSha256 } : {}),
    config_fingerprint: fingerprint,
    recorded_at: recordedAt,
  };
}

const checkString = (v: unknown, path: string, c: IssueCollector): string | undefined => {
  if (typeof v === "string" && v.length > 0) return v;
  c.add(path, "wrong_type", "expected non-empty string");
  return undefined;
};

const checkNumber = (v: unknown, path: string, c: IssueCollector): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  c.add(path, "wrong_type", "expected finite number");
  return undefined;
};

// ─── Question normalization (shared v1/v2 core) ──────────────────────

/**
 * Optional evidence fields: only an explicit recorded value becomes `present`.
 * Absence stays unknown — v1 producers wrote `x || undefined`, so a missing
 * flag is ambiguous between "false" and "not measured".
 */
function evidencedOptional<T>(
  q: Record<string, unknown>,
  key: string,
  path: string,
  c: IssueCollector,
  kind: "string" | "number" | "boolean",
  absentReason: string,
): Evidenced<T> | undefined {
  const v = q[key];
  if (v === undefined || v === null) return unavailable<T>(absentReason);
  if (typeof v !== kind) {
    c.add(`${path}.${key}`, "wrong_type", `expected ${kind}, got ${JSON.stringify(v)?.slice(0, 60)}`);
    return undefined;
  }
  return present(v as T);
}

function readQuestion(
  raw: unknown,
  path: string,
  c: IssueCollector,
  version: 1 | 2,
  gateEnabled: boolean,
): NormalizedQuestion | undefined {
  if (!isPlainObject(raw)) {
    c.add(path, "wrong_type", "expected question object");
    return undefined;
  }
  const questionId = reqString(raw, path, "question_id", c);
  const questionType = reqString(raw, path, "question_type", c);
  const category = reqString(raw, path, "category", c);
  const question = reqString(raw, path, "question", c);
  const groundTruth = reqString(raw, path, "ground_truth", c);
  const hypothesis = raw.hypothesis;
  const retrievalMs = reqNumber(raw, path, "retrieval_ms", c);
  const answerMs = reqNumber(raw, path, "answer_ms", c);
  const correct = reqBoolean(raw, path, "correct", c);
  if (typeof hypothesis !== "string") {
    c.add(`${path}.hypothesis`, raw.hypothesis === undefined ? "missing_field" : "wrong_type", "required string field");
  }

  let retrievedContext: string[] | null = null;
  if (raw.retrieved_context !== undefined) {
    if (Array.isArray(raw.retrieved_context) && raw.retrieved_context.every((x) => typeof x === "string")) {
      retrievedContext = raw.retrieved_context as string[];
    } else {
      c.add(`${path}.retrieved_context`, "wrong_type", "expected string[]");
      return undefined;
    }
  }

  const fieldAbsent =
    version === 1 ? UNAVAILABLE_REASONS.v1QuestionFieldAbsent : (f: string) => `v2 artifact did not record ${f}`;
  const gateAbsent = gateEnabled
    ? UNAVAILABLE_REASONS.gateEvidenceAbsent
    : UNAVAILABLE_REASONS.gateDisabled;

  const judgeLabel = evidencedOptional<string>(raw, "judge_label", path, c, "string", fieldAbsent("judge_label"));
  const judgeConfidence = evidencedOptional<number>(raw, "judge_confidence", path, c, "number", fieldAbsent("judge_confidence"));
  const consensusInvoked = evidencedOptional<boolean>(raw, "consensus_invoked", path, c, "boolean", gateAbsent);
  const consensusVerdict = evidencedOptional<string>(raw, "consensus_verdict", path, c, "string", gateAbsent);
  const consensusConfidence = evidencedOptional<number>(raw, "consensus_confidence", path, c, "number", gateAbsent);
  const truncated = evidencedOptional<boolean>(raw, "truncated", path, c, "boolean", fieldAbsent("truncated"));
  const timedOut = evidencedOptional<boolean>(raw, "timed_out", path, c, "boolean", fieldAbsent("timed_out"));

  let usage: Evidenced<UsageV2> | undefined;
  if (raw.usage === undefined) {
    usage = unavailable<UsageV2>(version === 1 ? UNAVAILABLE_REASONS.v1NoUsage : "v2 artifact did not record per-question usage");
  } else {
    usage = readEvidenced<UsageV2>(raw.usage, `${path}.usage`, c, readUsage);
  }

  if (
    questionId === undefined || questionType === undefined || category === undefined ||
    question === undefined || groundTruth === undefined || typeof hypothesis !== "string" ||
    retrievalMs === undefined || answerMs === undefined || correct === undefined ||
    judgeLabel === undefined || judgeConfidence === undefined || consensusInvoked === undefined ||
    consensusVerdict === undefined || consensusConfidence === undefined ||
    truncated === undefined || timedOut === undefined || usage === undefined
  ) {
    return undefined;
  }

  return {
    question_id: questionId,
    question_type: questionType,
    category,
    question,
    ground_truth: groundTruth,
    hypothesis,
    retrieved_context: retrievedContext,
    retrieval_ms: retrievalMs,
    answer_ms: answerMs,
    correct,
    judge_label: judgeLabel,
    judge_confidence: judgeConfidence,
    consensus_invoked: consensusInvoked,
    consensus_verdict: consensusVerdict,
    consensus_confidence: consensusConfidence,
    truncated,
    timed_out: timedOut,
    usage,
  };
}

function readQuestions(
  raw: unknown,
  path: string,
  c: IssueCollector,
  version: 1 | 2,
  gateEnabled: boolean,
): NormalizedQuestion[] | undefined {
  if (!Array.isArray(raw)) {
    c.add(path, raw === undefined ? "missing_field" : "wrong_type", "expected questions array");
    return undefined;
  }
  const out: NormalizedQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = readQuestion(raw[i], `${path}[${i}]`, c, version, gateEnabled);
    if (!q) return undefined;
    out.push(q);
  }
  return out;
}

// ─── v1 normalization ────────────────────────────────────────────────

function normalizeV1(raw: Record<string, unknown>): NormalizeResult {
  const c = new IssueCollector();
  const path = "$";

  const benchmark = reqString(raw, path, "benchmark", c);
  const timestamp = reqString(raw, path, "timestamp", c);
  const dataset = reqString(raw, path, "dataset", c);
  const totalQuestions = reqNumber(raw, path, "total_questions", c);
  const answered = reqNumber(raw, path, "answered", c);
  const scores = readScores(raw.scores, "$.scores", c);
  const latency = readLatency(raw.latency, "$.latency", c);

  // consensus_gate: v1 always records { enabled } and, when enabled, evidence.
  let consensus: ConsensusV2 | undefined;
  const gate = reqObject(raw, path, "consensus_gate", c);
  if (gate) {
    const enabled = reqBoolean(gate, "$.consensus_gate", "enabled", c);
    if (enabled !== undefined) {
      const evidence = (key: "threshold" | "invocations" | "splits"): Evidenced<number> | undefined => {
        if (gate[key] === undefined) {
          return unavailable<number>(
            enabled ? UNAVAILABLE_REASONS.gateEvidenceAbsent : UNAVAILABLE_REASONS.gateDisabled,
          );
        }
        const v = reqNumber(gate, "$.consensus_gate", key, c);
        return v === undefined ? undefined : present(v);
      };
      const threshold = evidence("threshold");
      const invocations = evidence("invocations");
      const splits = evidence("splits");
      if (threshold && invocations && splits) {
        consensus = { enabled, threshold, invocations, splits };
      }
    }
  }

  const gateEnabled = consensus?.enabled === true;
  const questions = readQuestions(raw.questions, "$.questions", c, 1, gateEnabled);

  // Optional replicate block (added to v1 late) → cohort evidence when present.
  let cohort: Evidenced<CohortV2> | undefined = unavailable<CohortV2>(UNAVAILABLE_REASONS.v1NoCohort);
  if (raw.replicate !== undefined) {
    const rep = reqObject(raw, path, "replicate", c);
    if (rep) {
      const index = reqNumber(rep, "$.replicate", "index", c);
      const seed = reqNumber(rep, "$.replicate", "seed", c);
      const cohortId = reqString(rep, "$.replicate", "cohort_id", c);
      const minimumN = reqNumber(rep, "$.replicate", "minimum_n", c);
      const timeoutMs = typeof rep.timeout_ms === "number" && Number.isFinite(rep.timeout_ms) ? rep.timeout_ms : null;
      if (index !== undefined && seed !== undefined && cohortId !== undefined && minimumN !== undefined) {
        cohort = present<CohortV2>({
          cohort_id: cohortId,
          replicate_index: index,
          replicate_seed: seed,
          minimum_n: minimumN,
          timeout_ms: timeoutMs,
        });
      } else {
        cohort = undefined;
      }
    } else {
      cohort = undefined;
    }
  }

  if (
    c.issues.length > 0 || benchmark === undefined || timestamp === undefined || dataset === undefined ||
    totalQuestions === undefined || answered === undefined || !scores || !latency || !consensus ||
    !questions || !cohort
  ) {
    return { ok: false, errors: c.issues };
  }

  return {
    ok: true,
    warnings: [],
    run: {
      schema_version: 1,
      run_id: unavailable<string>(UNAVAILABLE_REASONS.v1NoRunId),
      benchmark,
      timestamp,
      dataset,
      totals: { total_questions: totalQuestions, answered },
      scores,
      latency,
      cohort,
      provenance: unavailable<ProvenanceV2>(UNAVAILABLE_REASONS.v1NoProvenance),
      execution: unavailable<ExecutionV2>(UNAVAILABLE_REASONS.v1NoExecution),
      usage: unavailable<UsageV2>(UNAVAILABLE_REASONS.v1NoUsage),
      pricing: unavailable<PricingV2>(UNAVAILABLE_REASONS.v1NoPricing),
      consensus,
      parity: unavailable<ParityV2>(UNAVAILABLE_REASONS.v1NoParity),
      errors: [],
      questions,
    },
  };
}

// ─── v2 normalization ────────────────────────────────────────────────

function normalizeV2(raw: Record<string, unknown>): NormalizeResult {
  const c = new IssueCollector();

  const runObj = reqObject(raw, "$", "run", c);
  let identity: RunIdentityV2 | undefined;
  if (runObj) {
    const runId = reqString(runObj, "$.run", "run_id", c);
    const benchmark = reqString(runObj, "$.run", "benchmark", c);
    const timestamp = reqString(runObj, "$.run", "timestamp", c);
    const dataset = reqString(runObj, "$.run", "dataset", c);
    if (runId !== undefined && benchmark !== undefined && timestamp !== undefined && dataset !== undefined) {
      identity = { run_id: runId, benchmark, timestamp, dataset };
    }
  }

  let cohort: CohortV2 | undefined;
  const cohortObj = reqObject(raw, "$", "cohort", c);
  if (cohortObj) {
    const cohortId = reqString(cohortObj, "$.cohort", "cohort_id", c);
    const index = reqNumber(cohortObj, "$.cohort", "replicate_index", c);
    const seed = reqNumber(cohortObj, "$.cohort", "replicate_seed", c);
    const minimumN = reqNumber(cohortObj, "$.cohort", "minimum_n", c);
    const timeoutRaw = cohortObj.timeout_ms;
    let timeoutMs: number | null | undefined;
    if (timeoutRaw === null || timeoutRaw === undefined) timeoutMs = null;
    else if (typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)) timeoutMs = timeoutRaw;
    else {
      c.add("$.cohort.timeout_ms", "wrong_type", "expected number or null");
      timeoutMs = undefined;
    }
    if (cohortId !== undefined && index !== undefined && seed !== undefined && minimumN !== undefined && timeoutMs !== undefined) {
      cohort = {
        cohort_id: cohortId,
        replicate_index: index,
        replicate_seed: seed,
        minimum_n: minimumN,
        timeout_ms: timeoutMs,
      };
    }
  }

  const provenance = readProvenance(raw.provenance, "$.provenance", c);

  let execution: ExecutionV2 | undefined;
  const execObj = reqObject(raw, "$", "execution", c);
  if (execObj) {
    const answerModel = reqString(execObj, "$.execution", "answer_model", c);
    const guard = reqBoolean(execObj, "$.execution", "truncation_guard_enabled", c);
    const judgeModel = readEvidenced<string>(execObj.judge_model, "$.execution.judge_model", c, checkString);
    const embeddingModel = readEvidenced<string>(execObj.embedding_model, "$.execution.embedding_model", c, checkString);
    const timeout = readEvidenced<number>(execObj.generation_timeout_ms, "$.execution.generation_timeout_ms", c, checkNumber);
    if (answerModel !== undefined && guard !== undefined && judgeModel && embeddingModel && timeout) {
      execution = {
        answer_model: answerModel,
        judge_model: judgeModel,
        embedding_model: embeddingModel,
        truncation_guard_enabled: guard,
        generation_timeout_ms: timeout,
      };
    }
  }

  let totals: { total_questions: number; answered: number } | undefined;
  const totalsObj = reqObject(raw, "$", "totals", c);
  if (totalsObj) {
    const total = reqNumber(totalsObj, "$.totals", "total_questions", c);
    const answered = reqNumber(totalsObj, "$.totals", "answered", c);
    if (total !== undefined && answered !== undefined) totals = { total_questions: total, answered };
  }

  const scores = readScores(raw.scores, "$.scores", c);
  const latency = readLatency(raw.latency, "$.latency", c);
  const usage = readEvidenced<UsageV2>(raw.usage, "$.usage", c, readUsage);
  const pricing = readEvidenced<PricingV2>(raw.pricing, "$.pricing", c, readPricing);
  const parity = readEvidenced<ParityV2>(raw.parity, "$.parity", c, readParity);

  let consensus: ConsensusV2 | undefined;
  const gate = reqObject(raw, "$", "consensus", c);
  if (gate) {
    const enabled = reqBoolean(gate, "$.consensus", "enabled", c);
    const threshold = readEvidenced<number>(gate.threshold, "$.consensus.threshold", c, checkNumber);
    const invocations = readEvidenced<number>(gate.invocations, "$.consensus.invocations", c, checkNumber);
    const splits = readEvidenced<number>(gate.splits, "$.consensus.splits", c, checkNumber);
    if (enabled !== undefined && threshold && invocations && splits) {
      consensus = { enabled, threshold, invocations, splits };
    }
  }

  let errors: RunErrorV2[] | undefined;
  if (Array.isArray(raw.errors)) {
    errors = [];
    for (let i = 0; i < raw.errors.length; i++) {
      const e = raw.errors[i];
      if (!isPlainObject(e)) {
        c.add(`$.errors[${i}]`, "wrong_type", "expected error object");
        errors = undefined;
        break;
      }
      const stage = reqString(e, `$.errors[${i}]`, "stage", c);
      const message = reqString(e, `$.errors[${i}]`, "message", c);
      const qid = e.question_id;
      if (qid !== null && qid !== undefined && typeof qid !== "string") {
        c.add(`$.errors[${i}].question_id`, "wrong_type", "expected string or null");
        errors = undefined;
        break;
      }
      if (stage === undefined || message === undefined) {
        errors = undefined;
        break;
      }
      errors.push({ question_id: typeof qid === "string" ? qid : null, stage, message });
    }
  } else {
    c.add("$.errors", raw.errors === undefined ? "missing_field" : "wrong_type", "expected errors array (may be empty)");
  }

  const gateEnabled = consensus?.enabled === true;
  const questions = readQuestions(raw.questions, "$.questions", c, 2, gateEnabled);

  if (
    c.issues.length > 0 || !identity || !cohort || !provenance || !execution || !totals ||
    !scores || !latency || !usage || !pricing || !parity || !consensus || !errors || !questions
  ) {
    return { ok: false, errors: c.issues };
  }

  return {
    ok: true,
    warnings: [],
    run: {
      schema_version: 2,
      run_id: present(identity.run_id),
      benchmark: identity.benchmark,
      timestamp: identity.timestamp,
      dataset: identity.dataset,
      totals,
      scores,
      latency,
      cohort: present(cohort),
      provenance: present(provenance),
      execution: present(execution),
      usage,
      pricing,
      consensus,
      parity,
      errors,
      questions,
    },
  };
}

// ─── Public entry points ─────────────────────────────────────────────

/** Normalize a raw parsed artifact (v1 or v2) into the explorer read model. */
export function normalizeResultArtifact(raw: unknown): NormalizeResult {
  const detected = detectArtifactVersion(raw);
  if (detected.version === null) return { ok: false, errors: [detected.issue] };
  const obj = raw as Record<string, unknown>;
  return detected.version === 1 ? normalizeV1(obj) : normalizeV2(obj);
}

// ─── Aggregation ─────────────────────────────────────────────────────

export interface AggregateExclusion {
  key: string;
  errors: ContractIssue[];
}

export interface AggregateResult {
  included_runs: number;
  excluded: AggregateExclusion[];
  total_questions: number;
  answered: number;
  correct: number;
  /** null when no valid runs were included — never a fabricated zero. */
  overall_accuracy: number | null;
  by_category: Record<string, ScoreCell>;
}

/** Round to one decimal, matching the ZouroBench producer. */
function roundAccuracy(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
}

/**
 * Aggregate across artifacts. Invalid artifacts are excluded with their
 * structured errors; they never contribute zeros to totals.
 */
export function aggregateArtifacts(items: Array<{ key: string; raw: unknown }>): AggregateResult {
  const excluded: AggregateExclusion[] = [];
  const byCategory: Record<string, { correct: number; total: number }> = {};
  let included = 0;
  let totalQuestions = 0;
  let answered = 0;
  let correct = 0;

  for (const item of items) {
    const result = normalizeResultArtifact(item.raw);
    if (result.ok === false) {
      excluded.push({ key: item.key, errors: result.errors });
      continue;
    }
    included += 1;
    totalQuestions += result.run.totals.total_questions;
    answered += result.run.totals.answered;
    for (const [name, cell] of Object.entries(result.run.scores.by_category)) {
      const acc = (byCategory[name] ??= { correct: 0, total: 0 });
      acc.correct += cell.correct;
      acc.total += cell.total;
      correct += cell.correct;
    }
  }

  const scoredTotal = Object.values(byCategory).reduce((s, cell) => s + cell.total, 0);
  return {
    included_runs: included,
    excluded,
    total_questions: totalQuestions,
    answered,
    correct,
    overall_accuracy: included > 0 ? roundAccuracy(correct, scoredTotal) : null,
    by_category: Object.fromEntries(
      Object.entries(byCategory).map(([name, cell]) => [
        name,
        { correct: cell.correct, total: cell.total, accuracy: roundAccuracy(cell.correct, cell.total) },
      ]),
    ),
  };
}
