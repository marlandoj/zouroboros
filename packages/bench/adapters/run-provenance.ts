/**
 * ZouroBench producer-side provenance, usage, and pricing capture
 * (ZBRE-002 / ZOU-830).
 *
 * Pure helpers the adapter uses to emit a `schema_version: 2` artifact that is
 * a strict superset of the legacy v1 shape: every legacy top-level field is
 * preserved byte-identical, and the ZBRE-001 contract blocks (run, cohort,
 * provenance, execution, usage, pricing, consensus, parity, errors) are added
 * alongside them. Scoring behavior is never touched here.
 *
 * Field taxonomy (see contracts/FIELD-PROVENANCE.md for the full table):
 * - observed:  read directly from the environment or a provider response
 *              (git SHA, dirty state, host, argv, token counts, finish_reason)
 * - derived:   computed deterministically from observed inputs
 *              (dataset/question-set hashes, config fingerprint, usage sums,
 *              parity deltas)
 * - estimated: computed from a static snapshot, not a provider invoice
 *              (pricing, cost estimate)
 * - unavailable: evidence the run could not observe; always recorded as
 *              { value: null, availability_reason } — never zero/false.
 */

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { hostname } from "os";
import {
  type Evidenced,
  type ParityV2,
  type PricingV2,
  type UsageV2,
  normalizeResultArtifact,
  present,
  unavailable,
} from "../contracts/result-contract";

export const ADAPTER_VERSION = "2.0.0";
export const PRODUCED_BY = "zourobench-adapter";

// ─── Canonical hashing (derived fields) ──────────────────────────────

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in order.
 * Used for every fingerprint so two identical runs hash identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** Observed: hash of the raw dataset file bytes exactly as read from disk. */
export function computeDatasetHash(rawDatasetBytes: string | Uint8Array): string {
  return `sha256:${sha256Hex(rawDatasetBytes)}`;
}

export interface QuestionIdentity {
  category: string;
  id: string;
  type: string;
  question: string;
  answer: string;
}

/**
 * Derived: hash of the question set this run actually selected (category
 * filter and per-category limit applied), in run order. Two runs with the
 * same dataset, categories, and limit produce the same hash.
 */
export function computeQuestionSetHash(questions: QuestionIdentity[]): string {
  const identity = questions.map((q) => ({
    answer: q.answer,
    category: q.category,
    id: q.id,
    question: q.question,
    type: q.type,
  }));
  return `sha256:${sha256Hex(canonicalJson(identity))}`;
}

// ─── Non-secret configuration fingerprint ────────────────────────────

// "token(?!s)" blocks credential-ish keys (zo_token, apiToken) while allowing
// token-COUNT settings (max_answer_tokens, prompt_tokens), which are plural.
const SECRET_LIKE_KEY = /key|secret|password|auth|bearer|credential|token(?!s)/i;

/**
 * Fail closed: the fingerprint input is an explicit allowlist assembled by the
 * caller, and any key that even looks like a credential aborts the run before
 * anything is written. Values are never scanned — only declared keys exist.
 */
export function assertNoSecretLikeFlags(flags: Record<string, unknown>): void {
  for (const key of Object.keys(flags)) {
    if (SECRET_LIKE_KEY.test(key)) {
      throw new Error(
        `refusing to fingerprint config: key "${key}" looks like a credential; provenance flags must be non-secret`,
      );
    }
  }
}

/** Derived: sha256 over the canonical JSON of the non-secret config. */
export function computeConfigFingerprint(flags: Record<string, unknown>): string {
  assertNoSecretLikeFlags(flags);
  return `sha256:${sha256Hex(canonicalJson(flags))}`;
}

// ─── Git provenance (observed; "unavailable" literals on failure) ────

export interface GitProvenance {
  git_commit: string;
  git_dirty: boolean | null;
  repository_remote: string | null;
  branch: string | null;
  status: "observed" | "unavailable";
}

export type GitRunner = (args: string[]) => string | null;

export function defaultGitRunner(cwd: string): GitRunner {
  return (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
}

/** Strip userinfo from remote URLs so credentials can never leak into artifacts. */
export function scrubRemoteUrl(remote: string): string {
  return remote.replace(/^(\w+:\/\/)[^@/]+@/, "$1");
}

export function collectGitProvenance(runGit: GitRunner): GitProvenance {
  const commit = runGit(["rev-parse", "HEAD"]);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    return { git_commit: "unavailable", git_dirty: null, repository_remote: null, branch: null, status: "unavailable" };
  }
  const porcelain = runGit(["status", "--porcelain"]);
  const remote = runGit(["config", "--get", "remote.origin.url"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    git_commit: commit,
    git_dirty: porcelain === null ? null : porcelain.length > 0,
    repository_remote: remote ? scrubRemoteUrl(remote) : null,
    branch: branch && branch !== "HEAD" ? branch : null,
    status: "observed",
  };
}

// ─── Pricing snapshot (estimated) ────────────────────────────────────

/**
 * Static USD per 1M tokens. This is an ESTIMATE frozen at `as_of` — not a
 * provider invoice. A model missing from this table makes pricing
 * unavailable rather than silently costing $0.
 */
export const PRICING_SNAPSHOT = {
  as_of: "2026-07-31",
  currency: "USD",
  source: "static-model-pricing-table@2026-07-31 (estimated; not a provider invoice)",
  per_million_usd: {
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1": { input: 2, output: 8 },
    "kimi:kimi-k3": { input: 3, output: 15 },
    "or:moonshotai/kimi-k3": { input: 3, output: 15 },
    "or:x-ai/grok-4.5": { input: 2, output: 6 },
    "or:z-ai/glm-5.2": { input: 1.12, output: 3.52 },
    "or:qwen/qwen3.6-27b": { input: 0.3, output: 2 },
    "or:nvidia/nemotron-3-super-120b-a12b": { input: 0.085, output: 0.4 },
  } as Record<string, { input: number; output: number }>,
} as const;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface PricingBreakdown extends PricingV2 {
  by_model: Record<string, { input_cost: number; output_cost: number; total_cost: number }>;
  as_of: string;
}

/**
 * Estimated: cost from the pricing snapshot for every model with observed
 * usage. Returns an error reason instead of a number when any model has no
 * snapshot entry — an unpriceable run must not report a partial cost.
 */
export function estimateCost(
  usageByModel: Record<string, UsageV2>,
): { pricing: PricingBreakdown; error: null } | { pricing: null; error: string } {
  const models = Object.keys(usageByModel);
  if (models.length === 0) return { pricing: null, error: "no observed token usage to price" };
  const missing = models.filter((m) => !PRICING_SNAPSHOT.per_million_usd[m]);
  if (missing.length > 0) {
    return { pricing: null, error: `no pricing snapshot entry for model(s): ${missing.join(", ")}` };
  }
  const byModel: PricingBreakdown["by_model"] = {};
  let input = 0;
  let output = 0;
  for (const model of models) {
    const rate = PRICING_SNAPSHOT.per_million_usd[model]!;
    const usage = usageByModel[model]!;
    const inCost = round6((usage.prompt_tokens / 1_000_000) * rate.input);
    const outCost = round6((usage.completion_tokens / 1_000_000) * rate.output);
    byModel[model] = { input_cost: inCost, output_cost: outCost, total_cost: round6(inCost + outCost) };
    input += inCost;
    output += outCost;
  }
  return {
    pricing: {
      currency: PRICING_SNAPSHOT.currency,
      input_cost: round6(input),
      output_cost: round6(output),
      total_cost: round6(input + output),
      source: PRICING_SNAPSHOT.source,
      as_of: PRICING_SNAPSHOT.as_of,
      by_model: byModel,
    },
    error: null,
  };
}

// ─── Usage accumulation (observed counts, derived sums) ──────────────

export class UsageAccumulator {
  private totals: UsageV2 = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  private byModel: Record<string, UsageV2> = {};
  private observedCalls = 0;
  private unobservedCalls = 0;

  /** Record one provider call. `usage` is undefined when the provider returned none. */
  add(model: string, usage: UsageV2 | undefined): void {
    if (!usage) {
      this.unobservedCalls++;
      return;
    }
    this.observedCalls++;
    this.totals.prompt_tokens += usage.prompt_tokens;
    this.totals.completion_tokens += usage.completion_tokens;
    this.totals.total_tokens += usage.total_tokens;
    const slot = (this.byModel[model] ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    slot.prompt_tokens += usage.prompt_tokens;
    slot.completion_tokens += usage.completion_tokens;
    slot.total_tokens += usage.total_tokens;
  }

  coverage(): { observed_calls: number; unobserved_calls: number } {
    return { observed_calls: this.observedCalls, unobserved_calls: this.unobservedCalls };
  }

  usageByModel(): Record<string, UsageV2> {
    return this.byModel;
  }

  /** Run-level usage: sums when anything was observed, honest null otherwise. */
  evidencedTotals(): Evidenced<UsageV2> {
    if (this.observedCalls === 0) {
      return unavailable<UsageV2>("no provider call in this run returned token usage");
    }
    return present({ ...this.totals });
  }

  /** Estimated pricing over everything observed; unavailable stays honest. */
  evidencedPricing(): Evidenced<PricingBreakdown> {
    if (this.observedCalls === 0) {
      return unavailable<PricingBreakdown>("no observed token usage to price");
    }
    const { pricing, error } = estimateCost(this.byModel);
    if (!pricing) return unavailable<PricingBreakdown>(error ?? "pricing unavailable");
    // Partial coverage is still an estimate over what WAS observed; the
    // coverage counters in the artifact make any gap explicit.
    return present(pricing);
  }
}

export function sumQuestionUsage(parts: Array<UsageV2 | undefined>): UsageV2 | undefined {
  const observed = parts.filter((p): p is UsageV2 => p !== undefined);
  if (observed.length === 0) return undefined;
  return observed.reduce(
    (acc, u) => ({
      prompt_tokens: acc.prompt_tokens + u.prompt_tokens,
      completion_tokens: acc.completion_tokens + u.completion_tokens,
      total_tokens: acc.total_tokens + u.total_tokens,
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );
}

// ─── Parity reference (derived from a referenced baseline) ───────────

export function computeParity(
  currentOverallAccuracy: number,
  currentQuestionIds: string[],
  baselineRaw: unknown,
  baselineLabel: string,
): Evidenced<ParityV2> {
  const normalized = normalizeResultArtifact(baselineRaw);
  if (!normalized.ok) {
    return unavailable<ParityV2>(
      `parity baseline ${baselineLabel} failed contract validation: ${normalized.errors[0]?.message ?? "unknown error"}`,
    );
  }
  const baseline = normalized.run;
  const baselineIds = new Set(baseline.questions.map((q) => q.question_id));
  const paired = currentQuestionIds.filter((id) => baselineIds.has(id)).length;
  return present({
    baseline_run_id: baseline.run_id.value ?? `${baseline.benchmark}@${baseline.timestamp}`,
    baseline_overall_accuracy: baseline.scores.overall_accuracy,
    delta_overall_accuracy: Math.round((currentOverallAccuracy - baseline.scores.overall_accuracy) * 10) / 10,
    paired_questions: paired,
  });
}

// ─── v2 artifact assembly ────────────────────────────────────────────

export interface RunErrorEntry {
  question_id: string | null;
  stage: string;
  message: string;
}

export interface BuildArtifactInput {
  /** The legacy result object exactly as the adapter has always built it. */
  legacyResult: Record<string, unknown>;
  runId: string;
  benchmark: string;
  timestamp: string;
  dataset: string;
  totalQuestions: number;
  answered: number;
  cohort: {
    cohort_id: string;
    replicate_index: number;
    replicate_seed: number;
    replicate_seed_label: string;
    minimum_n: number;
    timeout_ms: number | null;
  };
  git: GitProvenance;
  host: string;
  invocation: string;
  datasetHash: string;
  questionSetHash: string;
  configFingerprint: string;
  /** Non-secret flags; assertNoSecretLikeFlags is re-applied here (fail closed). */
  flags: Record<string, unknown>;
  execution: {
    answer_model: string;
    judge_model: Evidenced<string>;
    embedding_model: Evidenced<string>;
    truncation_guard_enabled: boolean;
    generation_timeout_ms: Evidenced<number>;
    max_tokens: number;
  };
  usage: Evidenced<UsageV2>;
  usageCoverage: { observed_calls: number; unobserved_calls: number };
  pricing: Evidenced<PricingV2>;
  consensus: {
    enabled: boolean;
    threshold: Evidenced<number>;
    invocations: Evidenced<number>;
    splits: Evidenced<number>;
  };
  parity: Evidenced<ParityV2>;
  errors: RunErrorEntry[];
  recordedAt: string;
}

/**
 * Emit the v2 superset: spread the legacy artifact FIRST (so every legacy
 * reader sees exactly the bytes it always saw), then add the contract blocks.
 * None of the added keys collide with legacy top-level keys except
 * `questions`/`scores`/`latency`/`dataset`/`benchmark`/`timestamp`, which the
 * legacy object already carries in the contract-required shape.
 */
export function buildV2ResultArtifact(input: BuildArtifactInput): Record<string, unknown> {
  assertNoSecretLikeFlags(input.flags);
  return {
    ...input.legacyResult,
    schema_version: 2,
    run: {
      run_id: input.runId,
      benchmark: input.benchmark,
      timestamp: input.timestamp,
      dataset: input.dataset,
    },
    cohort: input.cohort,
    provenance: {
      produced_by: PRODUCED_BY,
      adapter_version: ADAPTER_VERSION,
      git_commit: input.git.git_commit,
      git_dirty: input.git.git_dirty,
      git_status: input.git.status,
      repository: {
        remote: input.git.repository_remote,
        branch: input.git.branch,
      },
      host: input.host,
      invocation: input.invocation,
      dataset_sha256: input.datasetHash,
      question_set_sha256: input.questionSetHash,
      config_fingerprint: input.configFingerprint,
      flags: input.flags,
      recorded_at: input.recordedAt,
    },
    execution: input.execution,
    totals: { total_questions: input.totalQuestions, answered: input.answered },
    usage: input.usage,
    usage_coverage: input.usageCoverage,
    pricing: input.pricing,
    consensus: input.consensus,
    parity: input.parity,
    errors: input.errors,
  };
}
