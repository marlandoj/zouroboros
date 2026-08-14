#!/usr/bin/env bun
/**
 * Standalone runner for the Snake Pit injection harness (ZOU-291).
 *
 * Wires SNAKE_PIT_FIXTURES (taxonomy.ts) through the REAL continuation retrieval path —
 * the same isolated-throwaway-DB + detectContinuation + ranked retrieval that
 * standalone/holdout-eval.ts uses — and renders a verdict per fixture via the pure
 * evaluator in snakepit/inject.ts. The continuation SUT covers the recall-shaped
 * archetypes (goodhart, blind-spot, distribution-shift); collapse fixtures are a
 * routing/diversity-rail concern and are reported as 'skip' here (the sweep runner,
 * ZOU-292, drives those against the diversity probe). Zero contamination of the live
 * memory DB — everything runs in /tmp.
 *
 * Lives under standalone/ (tsc-excluded) because it imports bun:sqlite and dynamically
 * imports the Skills continuation module by absolute path. Output protocol (stdout):
 *   SNAKE_CASE <id> <archetype> <pass|fail|skip>   one line per fixture
 *   SNAKE_RATE <0..1>                              pass fraction over applicable fixtures
 *   SNAKE_REPORT <json>                            full SnakePitReport (one line; sweep/dashboard consume this)
 */

import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { runSnakePit, type ProbeResult } from '../snakepit/inject.js';
import { SNAKE_PIT_FIXTURES, type AdversarialFixture, type ArchetypeId } from '../snakepit/taxonomy.js';

const WORKSPACE = process.env.ZO_WORKSPACE || '/home/workspace';
const CONTINUATION_MODULE = join(WORKSPACE, 'Skills/zo-memory-system/scripts/continuation.ts');
const TEST_DB_PATH = '/tmp/zo-snakepit-eval.db';

/** Archetypes the continuation retrieval SUT actually exercises. */
const CONTINUATION_ARCHETYPES = new Set<ArchetypeId>(['goodhart', 'blind-spot', 'distribution-shift']);

const FIXTURE_CANDIDATES = [
  fileURLToPath(new URL('../snakepit/snakepit-fixtures.json', import.meta.url)),
  join(WORKSPACE, 'packages/selfheal/src/snakepit/snakepit-fixtures.json'),
  join(WORKSPACE, 'Skills/zouroboros/skills/selfheal/scripts/snakepit-fixtures.json'),
];

interface FixtureFact {
  entity: string;
  key: string;
  value: string;
  text: string;
  category: string;
  decayClass: string;
  createdDaysAgo: number;
  lastAccessedDaysAgo: number;
}
interface FixtureEpisode {
  summary: string;
  outcome: 'success' | 'failure' | 'resolved' | 'ongoing';
  happenedDaysAgo: number;
  entities: string[];
  metadata?: Record<string, unknown>;
}
interface FixtureOpenLoop {
  title: string;
  summary: string;
  kind: 'task' | 'bug' | 'incident' | 'approval' | 'commitment' | 'other';
  status: 'open' | 'resolved' | 'stale' | 'superseded';
  priority: number;
  entity: string;
  createdDaysAgo: number;
  updatedDaysAgo: number;
}
interface CorpusSet {
  name: string;
  windowDays: number;
  facts: FixtureFact[];
  episodes: FixtureEpisode[];
  openLoops: FixtureOpenLoop[];
}

interface ContinuationModule {
  ensureContinuationSchema: (db: Database) => void;
  createEpisodeRecord: (
    db: Database,
    input: { summary: string; outcome: string; happenedAt: number; entities: string[]; metadata?: Record<string, unknown> }
  ) => unknown;
  upsertOpenLoop: (db: Database, input: Record<string, unknown>) => { id: string };
  detectContinuation: (query: string) => { needsMemory: boolean; score: number; keywords: string[]; reason: string };
}

function loadCorpus(): CorpusSet {
  for (const p of FIXTURE_CANDIDATES) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as CorpusSet;
  }
  throw new Error('snakepit-fixtures.json not found in any candidate path');
}

const ageToMs = (daysAgo: number): number => Date.now() - daysAgo * 24 * 3600 * 1000;
const ageToSec = (daysAgo: number): number => Math.floor(Date.now() / 1000) - daysAgo * 24 * 3600;

function setupDb(ensureContinuationSchema: (db: Database) => void): Database {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL,
      text TEXT,
      category TEXT DEFAULT 'fact',
      decay_class TEXT DEFAULT 'stable',
      importance REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_accessed INTEGER,
      confidence REAL DEFAULT 1.0,
      metadata TEXT
    );
    CREATE VIRTUAL TABLE facts_fts USING fts5(
      text, entity, key, value, category,
      content='facts', content_rowid='rowid'
    );
    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END;
    CREATE TABLE fact_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE TABLE episode_entities (
      episode_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      PRIMARY KEY (episode_id, entity)
    );
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      happened_at INTEGER NOT NULL,
      duration_ms INTEGER,
      procedure_id TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX idx_facts_lookup ON facts(entity, key);
  `);
  ensureContinuationSchema(db);
  return db;
}

function seedDb(db: Database, corpus: CorpusSet, cont: ContinuationModule): void {
  for (const fact of corpus.facts) {
    db.prepare(
      `INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, expires_at, last_accessed, confidence, metadata)
       VALUES (?, 'shared', ?, ?, ?, ?, ?, ?, 1.0, 'snakepit-fixture', ?, NULL, ?, 1.0, ?)`
    ).run(
      crypto.randomUUID(),
      fact.entity,
      fact.key,
      fact.value,
      fact.text,
      fact.category,
      fact.decayClass,
      ageToMs(fact.createdDaysAgo),
      ageToSec(fact.lastAccessedDaysAgo),
      JSON.stringify({ snakepit: true })
    );
  }
  for (const episode of corpus.episodes) {
    cont.createEpisodeRecord(db, {
      summary: episode.summary,
      outcome: episode.outcome,
      happenedAt: ageToSec(episode.happenedDaysAgo),
      entities: episode.entities,
      metadata: { ...episode.metadata, snakepit: true },
    });
  }
  for (const loop of corpus.openLoops) {
    const record = cont.upsertOpenLoop(db, {
      persona: 'shared',
      title: loop.title,
      summary: loop.summary,
      kind: loop.kind,
      status: loop.status,
      priority: loop.priority,
      entity: loop.entity,
      source: 'snakepit-fixture',
      metadata: { snakepit: true },
    });
    db.prepare('UPDATE open_loops SET created_at = ?, updated_at = ? WHERE id = ?').run(
      ageToSec(loop.createdDaysAgo),
      ageToSec(loop.updatedDaysAgo),
      record.id
    );
  }
}

function runContinuation(db: Database, cont: ContinuationModule, query: string, windowDays: number): string[] {
  const detection = cont.detectContinuation(query);
  if (!detection.needsMemory) return [];

  const tokens = (detection.keywords.length > 0 ? detection.keywords : query.toLowerCase().split(/\s+/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);

  const factRows = db
    .prepare(`SELECT entity, key, value, text, last_accessed, created_at FROM facts WHERE (last_accessed >= ? OR created_at >= ?)`)
    .all(ageToSec(windowDays), ageToMs(windowDays)) as Array<Record<string, unknown>>;
  const episodeRows = db
    .prepare(
      `SELECT e.summary, group_concat(ee.entity, ' ') as entities FROM episodes e
       LEFT JOIN episode_entities ee ON ee.episode_id = e.id WHERE e.happened_at >= ? GROUP BY e.id`
    )
    .all(ageToSec(windowDays)) as Array<Record<string, unknown>>;
  const loopRows = db
    .prepare(
      `SELECT title, summary, status, entity, updated_at FROM open_loops
       WHERE updated_at >= ? AND status IN ('open','stale','resolved')`
    )
    .all(ageToSec(windowDays)) as Array<Record<string, unknown>>;

  const results: Array<{ score: number; text: string }> = [];
  for (const row of factRows) {
    const text = `${row.entity}.${row.key || '_'} = ${row.value}`;
    const haystack = `${row.entity} ${row.key || ''} ${row.value} ${row.text || ''}`.toLowerCase();
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) results.push({ score: overlap + 0.2, text });
  }
  for (const row of episodeRows) {
    const text = String(row.summary);
    const haystack = `${row.summary} ${row.entities || ''}`.toLowerCase();
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) results.push({ score: overlap + 0.5, text });
  }
  for (const row of loopRows) {
    const text = `${row.title} — ${row.summary}`;
    const haystack = `${row.title} ${row.summary} ${row.entity || ''}`.toLowerCase();
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) results.push({ score: overlap + 0.8, text });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((r) => r.text.toLowerCase());
}

async function main() {
  if (!existsSync(CONTINUATION_MODULE)) {
    console.error(`continuation module not found at ${CONTINUATION_MODULE}`);
    process.exit(2);
  }

  const cont = (await import(CONTINUATION_MODULE)) as unknown as ContinuationModule;
  const corpus = loadCorpus();
  const db = setupDb(cont.ensureContinuationSchema);
  seedDb(db, corpus, cont);

  const probe = (fixture: AdversarialFixture): ProbeResult => {
    if (!CONTINUATION_ARCHETYPES.has(fixture.archetype)) {
      return { applicable: false, lines: [], needsMemory: false };
    }
    const detection = cont.detectContinuation(fixture.query);
    const lines = runContinuation(db, cont, fixture.query, corpus.windowDays);
    return { applicable: true, lines, needsMemory: detection.needsMemory };
  };

  const report = runSnakePit(probe, SNAKE_PIT_FIXTURES);

  for (const v of report.verdicts) {
    console.log(`SNAKE_CASE ${v.id} ${v.archetype} ${v.status}`);
  }
  console.log(`SNAKE_RATE ${report.passRate.toFixed(4)}`);
  console.log(`SNAKE_REPORT ${JSON.stringify(report)}`);

  db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
