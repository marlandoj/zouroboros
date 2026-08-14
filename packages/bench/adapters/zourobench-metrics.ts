export type UsageOperation = "embedding" | "answer" | "judge";

export interface TokenUsageRecord {
  provider: string;
  model: string;
  operation: UsageOperation;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  estimated: boolean;
  cost_usd: number | null;
}

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  exact_tokens: number;
  estimated_tokens: number;
  priced_cost_usd: number;
  priced_calls: number;
  unpriced_calls: number;
  by_operation: Record<string, {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    calls: number;
  }>;
  by_model: Record<string, {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    calls: number;
  }>;
}

export interface RetrievalQualityMetrics {
  method: "ground_truth_token_coverage_v1";
  recall_at_k: Record<string, number>;
  mrr: number;
  ndcg_at_k: Record<string, number>;
  relevant_chunk_count: number;
  ground_truth_token_count: number;
}

export interface CitationGroundednessMetrics {
  method: "lexical_claim_support_v1";
  claims: number;
  cited_claims: number;
  citations: number;
  valid_citations: number;
  citation_precision: number;
  citation_coverage: number;
  citation_groundedness: number;
}

interface Pricing {
  input: number;
  output: number;
  cachedInput?: number;
}

const DEFAULT_PRICING_PER_MTOK: Record<string, Pricing> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "kimi:kimi-k3": { input: 3, output: 15 },
  "or:moonshotai/kimi-k3": { input: 3, output: 15 },
  "or:x-ai/grok-4.5": { input: 2, output: 6 },
  "or:z-ai/glm-5.2": { input: 1.12, output: 3.52 },
  "or:qwen/qwen3.6-27b": { input: 0.3, output: 2 },
  "or:nvidia/nemotron-3-super-120b-a12b": { input: 0.085, output: 0.4 },
};

const STOP_WORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "are", "as", "at", "be", "because",
  "been", "before", "being", "between", "both", "but", "by", "can", "did", "do", "does", "for",
  "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "no", "not",
  "of", "on", "or", "our", "so", "that", "the", "their", "then", "there", "these", "they", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "will", "with", "yes", "you",
]);

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[c\d+\]/g, " ")
    .match(/[a-z0-9][a-z0-9._%:/+-]*/g)
    ?.map((token) => token.replace(/^[._:/+-]+|[._:/+-]+$/g, ""))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [];
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

function overlapRatio(expected: Set<string>, actual: Set<string>): number {
  if (expected.size === 0) return 0;
  let matched = 0;
  for (const token of expected) if (actual.has(token)) matched++;
  return matched / expected.size;
}

function readPricingOverrides(): Record<string, Pricing> {
  const raw = process.env.ZOUROBENCH_PRICING_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<Pricing>>;
    const valid: Record<string, Pricing> = {};
    for (const [model, price] of Object.entries(parsed)) {
      if (typeof price.input !== "number" || typeof price.output !== "number") continue;
      if (price.input < 0 || price.output < 0) continue;
      valid[model] = {
        input: price.input,
        output: price.output,
        ...(typeof price.cachedInput === "number" && price.cachedInput >= 0
          ? { cachedInput: price.cachedInput }
          : {}),
      };
    }
    return valid;
  } catch {
    return {};
  }
}

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

export function createUsageRecord(input: {
  provider: string;
  model: string;
  operation: UsageOperation;
  prompt: string;
  output?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  } | null;
}): TokenUsageRecord {
  const exactInput = input.usage?.input_tokens ?? input.usage?.prompt_tokens;
  const exactOutput = input.usage?.output_tokens ?? input.usage?.completion_tokens;
  const hasExact = Number.isFinite(exactInput) && Number.isFinite(exactOutput);
  const inputTokens = hasExact ? Number(exactInput) : estimateTokens(input.prompt);
  const outputTokens = hasExact ? Number(exactOutput) : estimateTokens(input.output ?? "");
  const cachedInputTokens = Number.isFinite(input.usage?.cached_input_tokens)
    ? Number(input.usage?.cached_input_tokens)
    : 0;
  const totalTokens = Number.isFinite(input.usage?.total_tokens)
    ? Number(input.usage?.total_tokens)
    : inputTokens + outputTokens;
  const pricing = { ...DEFAULT_PRICING_PER_MTOK, ...readPricingOverrides() }[input.model];
  const cost = pricing
    ? ((inputTokens - cachedInputTokens) * pricing.input
      + cachedInputTokens * (pricing.cachedInput ?? pricing.input)
      + outputTokens * pricing.output) / 1_000_000
    : null;

  return {
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
    estimated: !hasExact,
    cost_usd: cost === null ? null : round(cost, 8),
  };
}

export function aggregateUsage(records: TokenUsageRecord[]): UsageSummary {
  const summary: UsageSummary = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    exact_tokens: 0,
    estimated_tokens: 0,
    priced_cost_usd: 0,
    priced_calls: 0,
    unpriced_calls: 0,
    by_operation: {},
    by_model: {},
  };

  for (const record of records) {
    summary.input_tokens += record.input_tokens;
    summary.output_tokens += record.output_tokens;
    summary.total_tokens += record.total_tokens;
    summary.cached_input_tokens += record.cached_input_tokens;
    if (record.estimated) summary.estimated_tokens += record.total_tokens;
    else summary.exact_tokens += record.total_tokens;
    if (record.cost_usd === null) summary.unpriced_calls++;
    else {
      summary.priced_calls++;
      summary.priced_cost_usd += record.cost_usd;
    }

    for (const bucket of [
      summary.by_operation[record.operation] ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 },
      summary.by_model[record.model] ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 },
    ]) {
      bucket.input_tokens += record.input_tokens;
      bucket.output_tokens += record.output_tokens;
      bucket.total_tokens += record.total_tokens;
      bucket.cost_usd += record.cost_usd ?? 0;
      bucket.calls++;
    }
  }

  summary.priced_cost_usd = round(summary.priced_cost_usd, 8);
  for (const bucket of [...Object.values(summary.by_operation), ...Object.values(summary.by_model)]) {
    bucket.cost_usd = round(bucket.cost_usd, 8);
  }
  return summary;
}

export function computeRetrievalQuality(
  chunks: string[],
  groundTruth: string,
  kValues = [1, 3, 5, 10],
): RetrievalQualityMetrics {
  const truth = tokenSet(groundTruth);
  const chunkTokens = chunks.map(tokenSet);
  const relevance = chunkTokens.map((tokens) => overlapRatio(truth, tokens));
  const relevanceThreshold = Math.max(1, Math.min(3, Math.ceil(truth.size * 0.1)));
  const relevant = chunkTokens.map((tokens) => {
    let overlap = 0;
    for (const token of truth) if (tokens.has(token)) overlap++;
    return overlap >= relevanceThreshold;
  });
  const firstRelevant = relevant.findIndex(Boolean);
  const recallAtK: Record<string, number> = {};
  const ndcgAtK: Record<string, number> = {};

  for (const k of kValues) {
    const covered = new Set<string>();
    for (const tokens of chunkTokens.slice(0, k)) {
      for (const token of truth) if (tokens.has(token)) covered.add(token);
    }
    recallAtK[String(k)] = truth.size === 0 ? 0 : round(covered.size / truth.size);

    const dcg = relevance.slice(0, k).reduce((sum, gain, index) =>
      sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
    const idcg = [...relevance].sort((a, b) => b - a).slice(0, k).reduce((sum, gain, index) =>
      sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
    ndcgAtK[String(k)] = idcg === 0 ? 0 : round(dcg / idcg);
  }

  return {
    method: "ground_truth_token_coverage_v1",
    recall_at_k: recallAtK,
    mrr: firstRelevant === -1 ? 0 : round(1 / (firstRelevant + 1)),
    ndcg_at_k: ndcgAtK,
    relevant_chunk_count: relevant.filter(Boolean).length,
    ground_truth_token_count: truth.size,
  };
}

export function computeCitationGroundedness(
  answer: string,
  chunks: string[],
): CitationGroundednessMetrics {
  const claims = answer
    .split(/(?<=[.!?])\s+(?!\[C\d+\])|\n+/i)
    .map((claim) => claim.trim())
    .filter(Boolean);
  let citations = 0;
  let validCitations = 0;
  let citedClaims = 0;
  let supportSum = 0;

  for (const claim of claims) {
    const refs = [...claim.matchAll(/\[C(\d+)\]/gi)].map((match) => Number(match[1]));
    citations += refs.length;
    const validRefs = refs.filter((ref) => ref >= 1 && ref <= chunks.length);
    validCitations += validRefs.length;
    if (validRefs.length === 0) continue;
    citedClaims++;
    const claimTokens = tokenSet(claim);
    const support = Math.max(...validRefs.map((ref) => overlapRatio(claimTokens, tokenSet(chunks[ref - 1]!))));
    supportSum += support;
  }

  return {
    method: "lexical_claim_support_v1",
    claims: claims.length,
    cited_claims: citedClaims,
    citations,
    valid_citations: validCitations,
    citation_precision: citations === 0 ? 0 : round(validCitations / citations),
    citation_coverage: claims.length === 0 ? 0 : round(citedClaims / claims.length),
    citation_groundedness: claims.length === 0 ? 0 : round(supportSum / claims.length),
  };
}

export function averageRetrievalQuality(metrics: RetrievalQualityMetrics[]): RetrievalQualityMetrics {
  const keys = [...new Set(metrics.flatMap((metric) => Object.keys(metric.recall_at_k)))];
  const average = (values: number[]) => values.length === 0 ? 0 : round(values.reduce((a, b) => a + b, 0) / values.length);
  return {
    method: "ground_truth_token_coverage_v1",
    recall_at_k: Object.fromEntries(keys.map((key) => [key, average(metrics.map((metric) => metric.recall_at_k[key] ?? 0))])),
    mrr: average(metrics.map((metric) => metric.mrr)),
    ndcg_at_k: Object.fromEntries(keys.map((key) => [key, average(metrics.map((metric) => metric.ndcg_at_k[key] ?? 0))])),
    relevant_chunk_count: Math.round(average(metrics.map((metric) => metric.relevant_chunk_count))),
    ground_truth_token_count: Math.round(average(metrics.map((metric) => metric.ground_truth_token_count))),
  };
}

export function averageCitationGroundedness(metrics: CitationGroundednessMetrics[]): CitationGroundednessMetrics {
  const sum = (key: keyof CitationGroundednessMetrics) => metrics.reduce((total, metric) => total + Number(metric[key]), 0);
  const claims = sum("claims");
  const citations = sum("citations");
  const citedClaims = sum("cited_claims");
  const validCitations = sum("valid_citations");
  return {
    method: "lexical_claim_support_v1",
    claims,
    cited_claims: citedClaims,
    citations,
    valid_citations: validCitations,
    citation_precision: citations === 0 ? 0 : round(validCitations / citations),
    citation_coverage: claims === 0 ? 0 : round(citedClaims / claims),
    citation_groundedness: claims === 0
      ? 0
      : round(metrics.reduce((total, metric) => total + metric.citation_groundedness * metric.claims, 0) / claims),
  };
}
