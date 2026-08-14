#!/usr/bin/env bun
/**
 * Standalone runner for the anti-Goodhart held-out eval bank
 * (seed-antigoodhart-wiring-2026-06-01, E1). Invoked by introspect/holdout.ts.
 *
 * Mirrors the VISIBLE continuation harness (Skills/zo-memory-system/scripts/eval-continuation.ts)
 * — identical isolated throwaway DB, identical retrieval ranking — but seeds from the
 * RESERVED holdout-fixtures.json instead of the visible fixture set, and reuses the REAL
 * detectContinuation so the hidden score is sensitive to the system's actual continuation
 * logic. It builds its own /tmp DB and never touches the live memory DB (zero contamination).
 *
 * Lives under standalone/ (tsc-excluded) because it imports bun:sqlite and dynamically
 * imports the Skills continuation module by absolute path. Output protocol (stdout):
 *   HOLDOUT_CASE <id> <1|0>                   one line per case (1 = passed)
 *   HOLDOUT_SUBCHECK <id> detection|content <1|0>   display-only sub-rewards,
 *                                               weight 0, behind HOLDOUT_SUBCHECKS
 *                                               (default ON; =0 ⇒ omitted)
 *   HOLDOUT_RATE <0..1>                       overall pass fraction
 */

import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const WORKSPACE = process.env.ZO_WORKSPACE || '/home/workspace';
const CONTINUATION_MODULE = join(WORKSPACE, 'Skills/zo-memory-system/scripts/continuation.ts');
const TEST_DB_PATH = '/tmp/zo-holdout-eval.db';

const FIXTURE_CANDIDATES = [
  fileURLToPath(new URL('../introspect/holdout-fixtures.json', import.meta.url)),
  join(WORKSPACE, 'packages/selfheal/src/introspect/holdout-fixtures.json'),
  join(WORKSPACE, 'Skills/zouroboros/skills/selfheal/scripts/holdout-fixtures.json'),
];

// Local replenished bank (ZOU-279): minted cases live only under the data dir, never git.
const LOCAL_BANK_PATH = join(
  process.env.ZOUROBOROS_DATA_DIR || join(homedir(), '.zouroboros'),
  'holdout-fixtures.local.json'
);

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
interface FixtureCase {
  id: string;
  query: string;
  expectDetection: boolean;
  expectAny: string[];
}
interface FixtureSet {
  name: string;
  windowDays: number;
  threshold: number;
  facts: FixtureFact[];
  episodes: FixtureEpisode[];
  openLoops: FixtureOpenLoop[];
  cases: FixtureCase[];
}

interface LocalReplenishedBank {
  entries?: Array<{
    id: string;
    query: string;
    expectDetection: boolean;
    expectAny: string[];
    seedLoop: FixtureOpenLoop;
  }>;
}

/** Fold the local minted bank into the fixture so its cases are probed (ZOU-279). */
function mergeLocalReplenished(fixture: FixtureSet): FixtureSet {
  if (!existsSync(LOCAL_BANK_PATH)) return fixture;
  try {
    const local = JSON.parse(readFileSync(LOCAL_BANK_PATH, 'utf-8')) as LocalReplenishedBank;
    for (const e of local.entries ?? []) {
      fixture.openLoops.push(e.seedLoop);
      fixture.cases.push({
        id: e.id,
        query: e.query,
        expectDetection: e.expectDetection,
        expectAny: e.expectAny,
      });
    }
  } catch {
    // Corrupt local bank → ignore, fall back to the committed seed.
  }
  return fixture;
}

function loadFixtures(): FixtureSet {
  for (const p of FIXTURE_CANDIDATES) {
    if (existsSync(p)) return mergeLocalReplenished(JSON.parse(readFileSync(p, 'utf-8')) as FixtureSet);
  }
  throw new Error('holdout-fixtures.json not found in any candidate path');
}

function ageToMs(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 3600 * 1000;
}
function ageToSec(daysAgo: number): number {
  return Math.floor(Date.now() / 1000) - daysAgo * 24 * 3600;
}

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

interface ContinuationModule {
  ensureContinuationSchema: (db: Database) => void;
  createEpisodeRecord: (
    db: Database,
    input: {
      summary: string;
      outcome: string;
      happenedAt: number;
      entities: string[];
      metadata?: Record<string, unknown>;
    }
  ) => unknown;
  upsertOpenLoop: (db: Database, input: Record<string, unknown>) => { id: string };
  detectContinuation: (query: string) => { needsMemory: boolean; score: number; keywords: string[]; reason: string };
}

function seedDb(db: Database, fixture: FixtureSet, cont: ContinuationModule): void {
  for (const fact of fixture.facts) {
    db.prepare(
      `INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, expires_at, last_accessed, confidence, metadata)
       VALUES (?, 'shared', ?, ?, ?, ?, ?, ?, 1.0, 'holdout-fixture', ?, NULL, ?, 1.0, ?)`
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
      JSON.stringify({ holdout: true })
    );
  }

  for (const episode of fixture.episodes) {
    cont.createEpisodeRecord(db, {
      summary: episode.summary,
      outcome: episode.outcome,
      happenedAt: ageToSec(episode.happenedDaysAgo),
      entities: episode.entities,
      metadata: { ...episode.metadata, holdout: true },
    });
  }

  for (const loop of fixture.openLoops) {
    const record = cont.upsertOpenLoop(db, {
      persona: 'shared',
      title: loop.title,
      summary: loop.summary,
      kind: loop.kind,
      status: loop.status,
      priority: loop.priority,
      entity: loop.entity,
      source: 'holdout-fixture',
      metadata: { holdout: true },
    });
    db.prepare('UPDATE open_loops SET created_at = ?, updated_at = ? WHERE id = ?').run(
      ageToSec(loop.createdDaysAgo),
      ageToSec(loop.updatedDaysAgo),
      record.id
    );
  }
}

function runContinuation(
  db: Database,
  cont: ContinuationModule,
  query: string,
  windowDays: number
): string[] {
  const detection = cont.detectContinuation(query);
  if (!detection.needsMemory) return [];

  const tokens = (detection.keywords.length > 0 ? detection.keywords : query.toLowerCase().split(/\s+/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);

  const factRows = db
    .prepare(
      `SELECT entity, key, value, text, last_accessed, created_at FROM facts WHERE (last_accessed >= ? OR created_at >= ?)`
    )
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

interface CaseResult {
  /** Optimizer-facing reward: detection AND content (unchanged semantics). */
  ok: boolean;
  /** Display-only sub-rewards (weight 0) — see HOLDOUT_SUBCHECK below. */
  passedDetection: boolean;
  passedContent: boolean;
}

function evaluateCase(db: Database, cont: ContinuationModule, fixture: FixtureSet, testCase: FixtureCase): CaseResult {
  const detection = cont.detectContinuation(testCase.query);
  const lines = runContinuation(db, cont, testCase.query, fixture.windowDays);
  const passedDetection = detection.needsMemory === testCase.expectDetection;
  const passedContent =
    !testCase.expectDetection || testCase.expectAny.length === 0
      ? true
      : testCase.expectAny.some((needle) => lines.some((line) => line.includes(needle.toLowerCase())));
  return { ok: passedDetection && passedContent, passedDetection, passedContent };
}

async function main() {
  if (!existsSync(CONTINUATION_MODULE)) {
    // Fail closed but quiet: holdout.ts treats absent output as "unmeasurable" → tripwire dormant.
    console.error(`continuation module not found at ${CONTINUATION_MODULE}`);
    process.exit(2);
  }

  const cont = (await import(CONTINUATION_MODULE)) as unknown as ContinuationModule;
  const fixture = loadFixtures();
  const db = setupDb(cont.ensureContinuationSchema);
  seedDb(db, fixture, cont);

  // Display-only sub-rewards (P0-3). Default ON; HOLDOUT_SUBCHECKS=0 ⇒ legacy
  // output (only HOLDOUT_CASE + HOLDOUT_RATE). These are weight-0 diagnostics
  // the optimizer never targets — only HOLDOUT_CASE feeds the reward.
  const emitSubchecks = process.env.HOLDOUT_SUBCHECKS !== '0';

  let passed = 0;
  for (const testCase of fixture.cases) {
    const res = evaluateCase(db, cont, fixture, testCase);
    if (res.ok) passed++;
    console.log(`HOLDOUT_CASE ${testCase.id} ${res.ok ? 1 : 0}`);
    if (emitSubchecks) {
      console.log(`HOLDOUT_SUBCHECK ${testCase.id} detection ${res.passedDetection ? 1 : 0}`);
      console.log(`HOLDOUT_SUBCHECK ${testCase.id} content ${res.passedContent ? 1 : 0}`);
    }
  }
  const rate = fixture.cases.length === 0 ? 0 : passed / fixture.cases.length;
  console.log(`HOLDOUT_RATE ${rate.toFixed(4)}`);

  db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
