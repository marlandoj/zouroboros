import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getMemoryDbPath, getWorkspaceRoot } from 'zouroboros-core';
import type { MemoryConfig } from 'zouroboros-core';
import type { MetricResult, MetricStatus } from '../types.js';

export const RAG_SHADOW_MIN_COHORT = 20;
export const RAG_SHADOW_MAX_AGE_DAYS = 30;
export const RAG_SHADOW_MAX_DOMAIN_SHARE = 0.6;

export type RagEpisodeDomain = 'introspection' | 'development' | 'operations' | 'user';

export interface RagEpisodeCandidate {
  id: string;
  text: string;
  createdAt: number;
  domain: RagEpisodeDomain;
}

export interface RagRetrievalHit {
  id: string;
  value: string;
  score?: number;
  sources?: string[];
}

export interface RagJudgeResult {
  raw: string;
  score: number;
  provider: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface RagShadowDependencies {
  loadCandidates(): Promise<RagEpisodeCandidate[]>;
  retrieveProduction(query: string, limit: number): Promise<RagRetrievalHit[]>;
  retrieveLexical(query: string, limit: number): Promise<RagRetrievalHit[]>;
  judge(episode: string, contexts: string[]): Promise<RagJudgeResult>;
  persistTrace(trace: RagHealthShadowTrace): string;
  dispose?(): void | Promise<void>;
  now?: () => number;
  productionVectorEnabled?: boolean;
}

interface RagEpisodeTrace {
  episodeId: string;
  createdAt: number;
  domain: RagEpisodeDomain;
  summary: string;
  promptHash: string;
  productionHits: RagRetrievalHit[];
  lexicalHits: RagRetrievalHit[];
  rawJudgeOutput?: string;
  parsedScore?: number;
  provider?: string;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface RagHealthShadowTrace {
  schemaVersion: 1;
  mode: 'shadow';
  generatedAt: string;
  state: MetricStatus;
  tracePath?: string;
  cohort: {
    requested: number;
    rawCandidates: number;
    selected: number;
    duplicatesRemoved: number;
    newestAgeDays: number | null;
    domainCounts: Record<string, number>;
    insufficiencyReasons: string[];
  };
  retrieval: {
    productionApi: 'zouroboros-memory.routeMemoryQuery';
    lexicalDiagnostic: 'facts_fts-bm25';
    vectorEnabled: boolean;
  };
  aggregate: {
    mean: number;
    confidence95: [number, number];
    scoredEpisodes: number;
  } | null;
  episodes: RagEpisodeTrace[];
}

function normalizedSummary(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

export function classifyEpisodeDomain(text: string, entities = ''): RagEpisodeDomain {
  const haystack = `${entities} ${text}`.toLowerCase();
  if (/introspect|self.?heal|scorecard|zouroboros\.introspection/.test(haystack)) return 'introspection';
  if (/deploy|incident|service|runtime|maintenance|production|report/.test(haystack)) return 'operations';
  if (/code|repository|typescript|test|build|pull request|linear|github/.test(haystack)) return 'development';
  return 'user';
}

export function selectStratifiedCohort(
  candidates: RagEpisodeCandidate[],
  limit = RAG_SHADOW_MIN_COHORT,
): { selected: RagEpisodeCandidate[]; duplicatesRemoved: number } {
  const ordered = [...candidates].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const unique: RagEpisodeCandidate[] = [];
  for (const candidate of ordered) {
    const key = normalizedSummary(candidate.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const groups = new Map<RagEpisodeDomain, RagEpisodeCandidate[]>();
  for (const domain of ['introspection', 'development', 'operations', 'user'] as const) {
    groups.set(domain, []);
  }
  for (const candidate of unique) groups.get(candidate.domain)!.push(candidate);

  const selected: RagEpisodeCandidate[] = [];
  let offset = 0;
  while (selected.length < limit) {
    let added = false;
    for (const domain of ['introspection', 'development', 'operations', 'user'] as const) {
      const candidate = groups.get(domain)![offset];
      if (candidate && selected.length < limit) {
        selected.push(candidate);
        added = true;
      }
    }
    if (!added) break;
    offset++;
  }

  return { selected, duplicatesRemoved: candidates.length - unique.length };
}

export function assessCohortSufficiency(
  rawCount: number,
  selected: RagEpisodeCandidate[],
  duplicatesRemoved: number,
  nowMs: number,
): { reasons: string[]; newestAgeDays: number | null; domainCounts: Record<string, number> } {
  const reasons: string[] = [];
  const domainCounts: Record<string, number> = {};
  for (const episode of selected) domainCounts[episode.domain] = (domainCounts[episode.domain] ?? 0) + 1;

  if (selected.length < RAG_SHADOW_MIN_COHORT) reasons.push(`cohort_below_${RAG_SHADOW_MIN_COHORT}`);
  const newest = selected.reduce((max, episode) => Math.max(max, episode.createdAt), 0);
  const newestAgeDays = newest > 0 ? (nowMs / 1000 - newest) / 86400 : null;
  if (newestAgeDays === null || newestAgeDays > RAG_SHADOW_MAX_AGE_DAYS) reasons.push('cohort_stale');

  const domainValues = Object.values(domainCounts);
  const dominantShare = selected.length > 0 ? Math.max(0, ...domainValues) / selected.length : 1;
  if (domainValues.length < 3 || dominantShare > RAG_SHADOW_MAX_DOMAIN_SHARE) reasons.push('cohort_clustered');
  if (rawCount > 0 && duplicatesRemoved / rawCount > 0.1) reasons.push('cohort_duplicated');

  return { reasons, newestAgeDays, domainCounts };
}

export function buildFaithfulnessPrompt(episode: string, contexts: string[]): string {
  const ctxBlock = contexts.map((context, index) => `[${index + 1}] ${context}`).join('\n');
  return `You are a RAG faithfulness evaluator.

CONTEXT FACTS:
${ctxBlock}

EPISODE SUMMARY:
${episode}

Task: Score how faithfully the episode summary is grounded in the context facts above.
- 1.0 = all claims in the summary are directly supported by the context
- 0.5 = some claims are supported, some are not
- 0.0 = claims contradict or ignore the context entirely

Respond with ONLY a number between 0.0 and 1.0. No explanation.`;
}

export function bootstrapConfidence95(scores: number[], iterations = 2000): [number, number] {
  if (scores.length === 0) return [0, 0];
  let seed = 0x5a17c9e3;
  const means: number[] = [];
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let index = 0; index < scores.length; index++) {
      total += scores[Math.floor(random() * scores.length)]!;
    }
    means.push(total / scores.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.025)]!, means[Math.floor(iterations * 0.975)]!];
}

function metricStatus(value: number): MetricStatus {
  if (value >= 0.8) return 'HEALTHY';
  if (value > 0.6) return 'WARNING';
  return 'CRITICAL';
}

export async function evaluateRagHealthShadow(
  dependencies: RagShadowDependencies,
): Promise<RagHealthShadowTrace> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const candidates = await dependencies.loadCandidates();
  const { selected, duplicatesRemoved } = selectStratifiedCohort(candidates);
  const sufficiency = assessCohortSufficiency(candidates.length, selected, duplicatesRemoved, nowMs);
  if (dependencies.productionVectorEnabled === false) sufficiency.reasons.push('production_vector_disabled');

  const trace: RagHealthShadowTrace = {
    schemaVersion: 1,
    mode: 'shadow',
    generatedAt: new Date(nowMs).toISOString(),
    state: sufficiency.reasons.length > 0 ? 'INSUFFICIENT_EVIDENCE' : 'WARNING',
    cohort: {
      requested: RAG_SHADOW_MIN_COHORT,
      rawCandidates: candidates.length,
      selected: selected.length,
      duplicatesRemoved,
      newestAgeDays: sufficiency.newestAgeDays,
      domainCounts: sufficiency.domainCounts,
      insufficiencyReasons: sufficiency.reasons,
    },
    retrieval: {
      productionApi: 'zouroboros-memory.routeMemoryQuery',
      lexicalDiagnostic: 'facts_fts-bm25',
      vectorEnabled: dependencies.productionVectorEnabled !== false,
    },
    aggregate: null,
    episodes: selected.map((episode) => ({
      episodeId: episode.id,
      createdAt: episode.createdAt,
      domain: episode.domain,
      summary: episode.text,
      promptHash: '',
      productionHits: [],
      lexicalHits: [],
    })),
  };

  try {
    if (sufficiency.reasons.length === 0) {
      for (const [index, episode] of selected.entries()) {
        const episodeTrace = trace.episodes[index]!;
        try {
          const [productionHits, lexicalHits] = await Promise.all([
            dependencies.retrieveProduction(episode.text, 3),
            dependencies.retrieveLexical(episode.text, 3),
          ]);
          episodeTrace.productionHits = productionHits;
          episodeTrace.lexicalHits = lexicalHits;
          const contexts = productionHits.map((hit) => hit.value);
          const prompt = buildFaithfulnessPrompt(episode.text, contexts);
          episodeTrace.promptHash = createHash('sha256').update(prompt).digest('hex');
          const judged = await dependencies.judge(episode.text, contexts);
          episodeTrace.rawJudgeOutput = judged.raw;
          episodeTrace.parsedScore = judged.score;
          episodeTrace.provider = judged.provider;
          episodeTrace.model = judged.model;
          episodeTrace.latencyMs = judged.latencyMs;
          episodeTrace.costUsd = judged.costUsd;
          episodeTrace.usage = judged.usage;
        } catch (error) {
          episodeTrace.error = error instanceof Error ? error.message : String(error);
        }
      }

      const scores = trace.episodes
        .map((episode) => episode.parsedScore)
        .filter((score): score is number => typeof score === 'number');
      if (scores.length < RAG_SHADOW_MIN_COHORT) {
        trace.state = 'INSUFFICIENT_EVIDENCE';
        trace.cohort.insufficiencyReasons.push('scored_cohort_below_20');
      } else {
        const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        trace.state = metricStatus(mean);
        trace.aggregate = {
          mean,
          confidence95: bootstrapConfidence95(scores),
          scoredEpisodes: scores.length,
        };
      }
    }

    trace.tracePath = dependencies.persistTrace(trace);
    return trace;
  } finally {
    await dependencies.dispose?.();
  }
}

export function loadRagHealthCandidates(dbPath: string): RagEpisodeCandidate[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(`
      SELECT e.id,
             COALESCE(e.created_at, e.happened_at) created_at,
             substr(d.text, 1, instr(d.text || char(10), char(10)) - 1) summary,
             COALESCE(group_concat(ee.entity, ' '), '') entities
        FROM episodes e
        JOIN episode_documents d ON d.episode_id = e.id
        LEFT JOIN episode_entities ee ON ee.episode_id = e.id
       WHERE e.outcome IN ('success', 'ongoing', 'resolved')
         AND d.text NOT LIKE 'Conversation capture%'
         AND d.text NOT LIKE 'Zouroboros introspection scorecard%'
         AND d.text NOT LIKE 'Zouroboros evolution%'
       GROUP BY e.id, e.created_at, e.happened_at, d.text
       ORDER BY COALESCE(e.created_at, e.happened_at) DESC, e.id ASC
       LIMIT 250
    `).all() as Array<{ id: string; created_at: number; summary: string; entities: string }>;
    return rows
      .filter((row) => row.summary && row.summary.length > 20)
      .map((row) => ({
        id: row.id,
        text: row.summary.slice(0, 500),
        createdAt: row.created_at,
        domain: classifyEpisodeDomain(row.summary, row.entities),
      }));
  } finally {
    db.close();
  }
}

function createLiveDependencies(): RagShadowDependencies {
  const workspace = getWorkspaceRoot();
  const dbPath = getMemoryDbPath();
  const lexicalDb = new Database(dbPath, { readonly: true });
  const vectorEnabled = Boolean(process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY);
  const config: MemoryConfig = {
    enabled: true,
    dbPath,
    vectorEnabled,
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 1536,
    autoCapture: false,
    captureIntervalMinutes: 30,
    graphBoost: true,
    hydeExpansion: false,
    decayConfig: { permanent: Infinity, long: 365, medium: 90, short: 30 },
    reranker: { enabled: false },
  };
  let memoryInitialized = false;
  let memoryOwned = false;

  return {
    loadCandidates: async () => loadRagHealthCandidates(dbPath),
    productionVectorEnabled: vectorEnabled,
    retrieveProduction: async (query, limit) => {
      const memory = await import('zouroboros-memory');
      if (!memoryInitialized) {
        if (!memory.isInitialized()) {
          memory.init(config);
          memoryOwned = true;
        }
        memoryInitialized = true;
      }
      const results = await memory.routeMemoryQuery(query, config, {
        limit,
        rerank: false,
        sessionId: 'rag-health-shadow',
      });
      return results.map((result) => ({
        id: result.entry.id,
        value: result.entry.value,
        score: result.score,
        sources: [result.matchType],
      }));
    },
    retrieveLexical: async (query, limit) => {
      const safe = query
        .replace(/['"]/g, '')
        .split(/\s+/)
        .filter((word) => word.length > 1)
        .map((word) => `"${word}"`)
        .join(' OR ');
      if (!safe) return [];
      const rows = lexicalDb.query(`
        SELECT f.id, f.value, rank
          FROM facts_fts ff
          JOIN facts f ON f.rowid = ff.rowid
         WHERE facts_fts MATCH ?
           AND (f.expires_at IS NULL OR f.expires_at > strftime('%s', 'now'))
         ORDER BY rank
         LIMIT ?
      `).all(safe, limit) as Array<{ id: string; value: string; rank: number }>;
      return rows.map((row) => ({ id: row.id, value: row.value, score: row.rank, sources: ['fts'] }));
    },
    judge: async (episode, contexts) => {
      const specifier = ['..', '..', '..', 'memory', 'src', 'standalone', 'model-client.js'].join('/');
      const modelClient: any = await import(specifier);
      const result = await modelClient.generate({
        prompt: buildFaithfulnessPrompt(episode, contexts),
        workload: 'gate',
      });
      const parsed = parseFloat(result.content.trim());
      return {
        raw: result.content,
        score: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5,
        provider: result.provider,
        model: result.model,
        latencyMs: result.latency_ms,
        costUsd: result.cost_usd,
        usage: result.usage ? {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        } : undefined,
      };
    },
    persistTrace: (trace) => {
      const dir = join(workspace, '.zo/selfheal/rag-health-shadow');
      mkdirSync(dir, { recursive: true });
      const finalPath = join(dir, `trace-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
      const tempPath = `${finalPath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(trace, null, 2));
      renameSync(tempPath, finalPath);
      return finalPath;
    },
    dispose: async () => {
      lexicalDb.close();
      if (memoryInitialized && memoryOwned) {
        const memory = await import('zouroboros-memory');
        memory.shutdown();
      }
    },
  };
}

export function persistRagHealthScore(dbPath: string, score: number, createdAt = Date.now()): string {
  const db = new Database(dbPath);
  try {
    const id = `rag-health-${createdAt}-${randomUUID().slice(0, 8)}`;
    db.query(`
      INSERT INTO facts(id, persona, entity, key, value, text, category, source, created_at, last_accessed)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'introspect',
      'system.rag_health',
      'rag_health_score',
      score.toFixed(4),
      `RAG health faithfulness score: ${score.toFixed(4)}`,
      'metric',
      'zouroboros-selfheal',
      createdAt,
      Math.floor(createdAt / 1000),
    );
    return id;
  } finally {
    db.close();
  }
}

export async function measureRAGHealthShadow(
  dependencies?: RagShadowDependencies,
): Promise<MetricResult> {
  try {
    const trace = await evaluateRagHealthShadow(dependencies ?? createLiveDependencies());
    const value = trace.aggregate?.mean ?? 0;
    const detail = trace.state === 'INSUFFICIENT_EVIDENCE'
      ? `INSUFFICIENT_EVIDENCE: ${trace.cohort.insufficiencyReasons.join(', ')}; n=${trace.cohort.selected}`
      : `Shadow faithfulness: ${(value * 100).toFixed(1)}% across ${trace.aggregate!.scoredEpisodes} episodes; 95% CI ${(trace.aggregate!.confidence95[0] * 100).toFixed(1)}-${(trace.aggregate!.confidence95[1] * 100).toFixed(1)}%`;
    return {
      name: 'RAG Health Shadow',
      value,
      target: 0.8,
      critical: 0.6,
      weight: 0,
      score: trace.aggregate ? (value >= 0.8 ? 1 : value <= 0.6 ? 0 : (value - 0.6) / 0.2) : 0,
      status: trace.state,
      trend: '—',
      detail,
      recommendation: trace.state === 'INSUFFICIENT_EVIDENCE'
        ? 'Refresh and diversify the evaluation cohort before interpreting faithfulness'
        : 'Continue shadow collection until seven scheduled observations are captured',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[rag-health-shadow] ${message}`);
    return {
      name: 'RAG Health Shadow',
      value: 0,
      target: 0.8,
      critical: 0.6,
      weight: 0,
      score: 0,
      status: 'INSUFFICIENT_EVIDENCE',
      trend: '—',
      detail: `INSUFFICIENT_EVIDENCE: shadow evaluator failed: ${message}`,
      recommendation: 'Repair shadow trace collection before interpreting or promoting this metric',
    };
  }
}
