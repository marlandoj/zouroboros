import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assessCohortSufficiency,
  evaluateRagHealthShadow,
  loadRagHealthCandidates,
  measureRAGHealthShadow,
  persistRagHealthScore,
  selectStratifiedCohort,
  type RagEpisodeCandidate,
  type RagHealthShadowTrace,
} from '../introspect/rag-health-shadow';
import { loadRagHealthEpisodes, loadRagHealthScoreHistory } from '../introspect/collector';

const tempDirs: string[] = [];
const originalMemoryDb = process.env.ZOUROBOROS_MEMORY_DB;
const originalLegacyMemoryDb = process.env.ZO_MEMORY_DB;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalMemoryDb === undefined) delete process.env.ZOUROBOROS_MEMORY_DB;
  else process.env.ZOUROBOROS_MEMORY_DB = originalMemoryDb;
  if (originalLegacyMemoryDb === undefined) delete process.env.ZO_MEMORY_DB;
  else process.env.ZO_MEMORY_DB = originalLegacyMemoryDb;
});

function candidates(nowMs: number, ageDays = 1): RagEpisodeCandidate[] {
  const domains = ['introspection', 'development', 'operations', 'user'] as const;
  return Array.from({ length: 24 }, (_, index) => ({
    id: `episode-${index.toString().padStart(2, '0')}`,
    text: `Unique episode summary ${index} with enough content for evaluation`,
    createdAt: Math.floor(nowMs / 1000) - ageDays * 86400 - index,
    domain: domains[index % domains.length],
  }));
}

describe('RAG health shadow cohort', () => {
  test('deduplicates and selects a deterministic domain-stratified cohort', () => {
    const now = Date.UTC(2026, 6, 22);
    const rows = candidates(now);
    rows.push({ ...rows[0]!, id: 'duplicate', text: rows[0]!.text.toUpperCase() });
    const first = selectStratifiedCohort(rows);
    const second = selectStratifiedCohort([...rows].reverse());

    expect(first.selected.map((row) => row.id)).toEqual(second.selected.map((row) => row.id));
    expect(first.selected).toHaveLength(20);
    expect(first.duplicatesRemoved).toBe(1);
    expect(new Set(first.selected.map((row) => row.domain)).size).toBe(4);
  });

  test('marks stale cohorts insufficient before retrieval or judging', async () => {
    const now = Date.UTC(2026, 6, 22);
    let retrievalCalls = 0;
    let judgeCalls = 0;
    let persisted: RagHealthShadowTrace | null = null;
    const trace = await evaluateRagHealthShadow({
      now: () => now,
      loadCandidates: async () => candidates(now, 40),
      retrieveProduction: async () => { retrievalCalls++; return []; },
      retrieveLexical: async () => { retrievalCalls++; return []; },
      judge: async () => {
        judgeCalls++;
        return { raw: '1', score: 1, provider: 'test', model: 'test', latencyMs: 1, costUsd: 0 };
      },
      persistTrace: (value) => { persisted = value; return '/tmp/trace.json'; },
      productionVectorEnabled: true,
    });

    expect(trace.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(trace.cohort.insufficiencyReasons).toContain('cohort_stale');
    expect(retrievalCalls).toBe(0);
    expect(judgeCalls).toBe(0);
    expect(persisted?.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(trace.episodes).toHaveLength(20);
    expect(trace.episodes[0]?.episodeId).toBe('episode-00');
    expect(trace.episodes[0]?.productionHits).toEqual([]);
  });

  test('captures production, lexical, judge, and confidence evidence for sufficient cohorts', async () => {
    const now = Date.UTC(2026, 6, 22);
    let productionCalls = 0;
    let lexicalCalls = 0;
    let judgeCalls = 0;
    const trace = await evaluateRagHealthShadow({
      now: () => now,
      loadCandidates: async () => candidates(now),
      retrieveProduction: async (_query, limit) => {
        productionCalls++;
        return Array.from({ length: limit }, (_, index) => ({ id: `p-${index}`, value: `production ${index}` }));
      },
      retrieveLexical: async (_query, limit) => {
        lexicalCalls++;
        return Array.from({ length: limit }, (_, index) => ({ id: `l-${index}`, value: `lexical ${index}` }));
      },
      judge: async () => {
        judgeCalls++;
        return {
          raw: judgeCalls % 2 ? '1.0' : '0.5',
          score: judgeCalls % 2 ? 1 : 0.5,
          provider: 'test-provider',
          model: 'test-model',
          latencyMs: 5,
          costUsd: 0.001,
          usage: { inputTokens: 10, outputTokens: 1 },
        };
      },
      persistTrace: () => '/tmp/trace.json',
      productionVectorEnabled: true,
    });

    expect(trace.state).toBe('WARNING');
    expect(trace.aggregate?.mean).toBe(0.75);
    expect(trace.aggregate?.scoredEpisodes).toBe(20);
    expect(trace.aggregate?.confidence95[0]).toBeLessThanOrEqual(0.75);
    expect(trace.aggregate?.confidence95[1]).toBeGreaterThanOrEqual(0.75);
    expect(productionCalls).toBe(20);
    expect(lexicalCalls).toBe(20);
    expect(judgeCalls).toBe(20);
    expect(trace.episodes[0]?.promptHash).toHaveLength(64);
    expect(trace.episodes[0]?.provider).toBe('test-provider');
  });

  test('reports clustered cohorts as insufficient', () => {
    const now = Date.UTC(2026, 6, 22);
    const selected = candidates(now).slice(0, 20).map((row) => ({ ...row, domain: 'introspection' as const }));
    const result = assessCohortSufficiency(20, selected, 0, now);
    expect(result.reasons).toContain('cohort_clustered');
  });
});

describe('RAG health metric persistence', () => {
  test('writes required timestamps for governor-readable facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-health-persist-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE facts(
        id TEXT PRIMARY KEY,
        persona TEXT NOT NULL,
        entity TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        text TEXT,
        category TEXT,
        source TEXT,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER
      )
    `);
    db.close();

    const id = persistRagHealthScore(dbPath, 0.8, 1234567890123);
    const verify = new Database(dbPath, { readonly: true });
    const row = verify.query('SELECT id, value, text, created_at, last_accessed, source FROM facts').get() as Record<string, unknown>;
    verify.close();

    expect(row.id).toBe(id);
    expect(row.value).toBe('0.8000');
    expect(row.text).toBe('RAG health faithfulness score: 0.8000');
    expect(row.created_at).toBe(1234567890123);
    expect(row.last_accessed).toBe(1234567890);
    expect(row.source).toBe('zouroboros-selfheal');
  });

  test('loads evaluable episodes while excluding synthetic pipeline summaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-health-episodes-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE episodes(id TEXT PRIMARY KEY, summary TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER, happened_at INTEGER);
      CREATE TABLE episode_documents(episode_id TEXT PRIMARY KEY, text TEXT NOT NULL);
      CREATE TABLE episode_entities(episode_id TEXT NOT NULL, entity TEXT NOT NULL);
    `);
    for (const [index, outcome] of ['success', 'ongoing', 'resolved', 'failure'].entries()) {
      const id = `episode-${outcome}`;
      db.query('INSERT INTO episodes(id, summary, outcome, created_at, happened_at) VALUES(?, ?, ?, ?, ?)')
        .run(id, `${outcome} episode`, outcome, 1_700_000_000 + index, 1_700_000_000 + index);
      db.query('INSERT INTO episode_documents(episode_id, text) VALUES(?, ?)')
        .run(id, `A sufficiently detailed ${outcome} episode summary for evaluation\nmetadata`);
      db.query('INSERT INTO episode_entities(episode_id, entity) VALUES(?, ?)').run(id, 'zouroboros.introspection');
    }
    for (const [index, [id, text]] of [
      ['episode-scorecard', 'Zouroboros introspection scorecard: composite 72/100 with synthetic metric details'],
      ['episode-capture', 'Conversation capture: automated pipeline metadata without user claims'],
      ['episode-evolution', 'Zouroboros evolution d942f89f: undefined succeeded for test_coverage; delta NaN percentage points.'],
    ].entries()) {
      db.query('INSERT INTO episodes(id, summary, outcome, created_at, happened_at) VALUES(?, ?, ?, ?, ?)')
        .run(id, id, 'success', 1_700_000_100 + index, 1_700_000_100 + index);
      db.query('INSERT INTO episode_documents(episode_id, text) VALUES(?, ?)').run(id, text);
      db.query('INSERT INTO episode_entities(episode_id, entity) VALUES(?, ?)').run(id, 'zouroboros.introspection');
    }
    db.close();

    const shadowCandidates = loadRagHealthCandidates(dbPath);
    expect(shadowCandidates.map((candidate) => candidate.id)).toEqual([
      'episode-resolved',
      'episode-ongoing',
      'episode-success',
    ]);
    expect(loadRagHealthEpisodes(dbPath).map((episode) => episode.id)).toEqual([
      'episode-success',
    ]);
  });

  test('samples up to 10 evaluable episodes for stable faithfulness measurement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-health-sample-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE episodes(id TEXT PRIMARY KEY, summary TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER, happened_at INTEGER);
      CREATE TABLE episode_documents(episode_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    `);
    // 15 success episodes, newest first; expect the 10 most recent.
    for (let index = 0; index < 15; index++) {
      const id = `episode-${index.toString().padStart(2, '0')}`;
      db.query('INSERT INTO episodes(id, summary, outcome, created_at, happened_at) VALUES(?, ?, ?, ?, ?)')
        .run(id, id, 'success', 1_700_000_000 + index, 1_700_000_000 + index);
      db.query('INSERT INTO episode_documents(episode_id, text) VALUES(?, ?)')
        .run(id, `A sufficiently detailed success episode summary number ${index} for evaluation`);
    }
    db.close();

    const episodes = loadRagHealthEpisodes(dbPath);
    expect(episodes).toHaveLength(10);
    expect(episodes[0]?.id).toBe('episode-14'); // newest first
    expect(episodes[9]?.id).toBe('episode-05');
  });

  test('reads back persisted rag_health_score history newest-first for the moving average', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-health-history-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE facts(
        id TEXT PRIMARY KEY, persona TEXT NOT NULL, entity TEXT NOT NULL, key TEXT,
        value TEXT NOT NULL, text TEXT, category TEXT, source TEXT,
        created_at INTEGER NOT NULL, last_accessed INTEGER
      )
    `);
    db.close();

    persistRagHealthScore(dbPath, 0.6, 1000);
    persistRagHealthScore(dbPath, 0.7, 2000);
    persistRagHealthScore(dbPath, 0.8, 3000);
    persistRagHealthScore(dbPath, 0.9, 4000);

    expect(loadRagHealthScoreHistory(dbPath, 3)).toEqual([0.9, 0.8, 0.7]);
    expect(loadRagHealthScoreHistory(dbPath, 3).reduce((a, b) => a + b, 0) / 3).toBeCloseTo(0.8);
  });

  test('returns insufficient evidence when the live database is unavailable', async () => {
    process.env.ZOUROBOROS_MEMORY_DB = '/tmp/rag-health-shadow-missing/database.db';
    process.env.ZO_MEMORY_DB = '';

    const result = await measureRAGHealthShadow();

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.detail).toContain('shadow evaluator failed');
  });
});
