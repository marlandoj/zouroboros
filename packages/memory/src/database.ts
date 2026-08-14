/**
 * Database management for Zouroboros Memory
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { MemoryConfig } from 'zouroboros-core';

let db: Database | null = null;

const SCHEMA_SQL = `
-- Facts table (core memory storage)
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  persona TEXT,
  entity TEXT NOT NULL,
  key TEXT,
  value TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT DEFAULT 'fact' CHECK(category IN ('preference', 'fact', 'decision', 'convention', 'other', 'reference', 'project')),
  decay_class TEXT DEFAULT 'medium' CHECK(decay_class IN ('permanent', 'long', 'medium', 'short')),
  importance REAL DEFAULT 1.0,
  source TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  expires_at INTEGER,
  last_accessed INTEGER DEFAULT (strftime('%s', 'now')),
  confidence REAL DEFAULT 1.0,
  metadata TEXT
);

-- Vector embeddings for semantic search
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT DEFAULT 'text-embedding-3-small',
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Episodes (event-based memory)
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'resolved', 'ongoing')),
  happened_at INTEGER NOT NULL,
  duration_ms INTEGER,
  procedure_id TEXT,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Episode entity links
CREATE TABLE IF NOT EXISTS episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity)
);

-- Procedures (workflow memory)
CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  steps TEXT NOT NULL, -- JSON array
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  evolved_from TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Open loops (tracking unresolved items)
CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  entity TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  priority INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  resolved_at INTEGER
);

-- Continuation context
CREATE TABLE IF NOT EXISTS continuation_context (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  last_summary TEXT NOT NULL,
  open_loop_ids TEXT, -- JSON array
  entity_stack TEXT, -- JSON array
  last_agent TEXT,
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Cognitive profiles
CREATE TABLE IF NOT EXISTS cognitive_profiles (
  entity TEXT PRIMARY KEY,
  traits TEXT, -- JSON object
  preferences TEXT, -- JSON object
  interaction_count INTEGER DEFAULT 0,
  last_interaction INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Skill Crystallization v1: candidates produced from weighted-success patterns
CREATE TABLE IF NOT EXISTS crystallizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('procedure', 'episode', 'skill_execution', 'mixed')),
  source_ids TEXT NOT NULL, -- JSON array of source row IDs
  source_signature TEXT NOT NULL UNIQUE, -- sha256 of sorted(source_ids); dedupes cron+hook races
  weighted_score REAL NOT NULL,
  draft_path TEXT NOT NULL,
  promoted_path TEXT,
  eval_status TEXT NOT NULL DEFAULT 'pending' CHECK(eval_status IN ('pending', 'mechanical_pass', 'mechanical_fail', 'replay_pass', 'replay_fail', 'mechanical_only', 'complete')),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'expired')),
  approval_token_prefix_8 TEXT, -- first 8 chars of HMAC; never store full token
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron', 'event_hook', 'manual')),
  llm_cost_usd REAL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  evaluated_at INTEGER,
  approved_at INTEGER,
  expires_at INTEGER NOT NULL -- created_at + 14d
);

-- Append-only audit log; status transitions live here, not as UPDATEs to crystallizations
CREATE TABLE IF NOT EXISTS crystallization_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crystallization_id TEXT NOT NULL REFERENCES crystallizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('created', 'mechanical_eval', 'replay_eval', 'email_sent', 'approved', 'rejected', 'expired', 'promoted', 'reverted', 'threshold_changed')),
  payload TEXT, -- JSON; e.g. {pattern_matched, files_diff, token_prefix_8}
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class, expires_at);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
CREATE INDEX IF NOT EXISTS idx_episode_entities ON episode_entities(entity);
CREATE INDEX IF NOT EXISTS idx_open_loops_entity ON open_loops(entity, status);
CREATE INDEX IF NOT EXISTS idx_crystallizations_status ON crystallizations(eval_status, approval_status);
CREATE INDEX IF NOT EXISTS idx_crystallizations_slug ON crystallizations(slug);
CREATE INDEX IF NOT EXISTS idx_crystallizations_expires ON crystallizations(expires_at) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crystallization_events_id ON crystallization_events(crystallization_id, created_at);
`;

/**
 * Initialize the database with schema
 */
export function initDatabase(config: MemoryConfig): Database {
  if (db) return db;

  // Ensure directory exists
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) {
    const { mkdirSync } = require('fs');
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  return db;
}

/**
 * Get the database instance (must call initDatabase first)
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Check if database is initialized
 */
export function isInitialized(): boolean {
  return db !== null;
}

/**
 * Run database migrations
 */
export function runMigrations(config: MemoryConfig): void {
  const database = initDatabase(config);
  
  // Migration tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  // Get applied migrations
  const applied = database.query('SELECT name FROM _migrations').all() as { name: string }[];
  const appliedSet = new Set(applied.map(m => m.name));

  // Define migrations
  const migrations: { name: string; sql: string }[] = [
    {
      name: '001_ensure_facts_persona_column',
      sql: `
        -- Add persona column if missing (idempotent via pragma check)
        -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
        -- so we check the schema first
        CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
      `,
    },
    {
      name: '002_backfill_facts_persona_shared',
      sql: `UPDATE facts SET persona = 'shared' WHERE persona IS NULL;`,
    },
    {
      name: '003_create_crystallizations',
      sql: `
        CREATE TABLE IF NOT EXISTS crystallizations (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('procedure', 'episode', 'skill_execution', 'mixed')),
          source_ids TEXT NOT NULL,
          source_signature TEXT NOT NULL UNIQUE,
          weighted_score REAL NOT NULL,
          draft_path TEXT NOT NULL,
          promoted_path TEXT,
          eval_status TEXT NOT NULL DEFAULT 'pending' CHECK(eval_status IN ('pending', 'mechanical_pass', 'mechanical_fail', 'replay_pass', 'replay_fail', 'mechanical_only', 'complete')),
          approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'expired')),
          approval_token_prefix_8 TEXT,
          trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron', 'event_hook', 'manual')),
          llm_cost_usd REAL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          evaluated_at INTEGER,
          approved_at INTEGER,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_crystallizations_status ON crystallizations(eval_status, approval_status);
        CREATE INDEX IF NOT EXISTS idx_crystallizations_slug ON crystallizations(slug);
        CREATE INDEX IF NOT EXISTS idx_crystallizations_expires ON crystallizations(expires_at) WHERE approval_status = 'pending';
      `,
    },
    {
      name: '004_create_crystallization_events',
      sql: `
        CREATE TABLE IF NOT EXISTS crystallization_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crystallization_id TEXT NOT NULL REFERENCES crystallizations(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK(event_type IN ('created', 'mechanical_eval', 'replay_eval', 'email_sent', 'approved', 'rejected', 'expired', 'promoted', 'reverted', 'threshold_changed')),
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_crystallization_events_id ON crystallization_events(crystallization_id, created_at);
      `,
    },
  ];

  // Apply pending migrations
  for (const migration of migrations) {
    if (!appliedSet.has(migration.name)) {
      database.exec(migration.sql);
      database.run(
        'INSERT INTO _migrations (name) VALUES (?)',
        [migration.name]
      );
    }
  }
}

/**
 * Get database statistics
 */
export function getDbStats(config: MemoryConfig): {
  facts: number;
  episodes: number;
  procedures: number;
  openLoops: number;
  embeddings: number;
} {
  const database = initDatabase(config);

  return {
    facts: (database.query('SELECT COUNT(*) as count FROM facts').get() as { count: number }).count,
    episodes: (database.query('SELECT COUNT(*) as count FROM episodes').get() as { count: number }).count,
    procedures: (database.query('SELECT COUNT(*) as count FROM procedures').get() as { count: number }).count,
    openLoops: (database.query('SELECT COUNT(*) as count FROM open_loops').get() as { count: number }).count,
    embeddings: (database.query('SELECT COUNT(*) as count FROM fact_embeddings').get() as { count: number }).count,
  };
}
