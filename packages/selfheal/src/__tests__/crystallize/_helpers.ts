/**
 * Test helpers — creates a fresh in-memory DB with the crystallizations
 * tables applied. We don't go through `runMigrations()` because that uses a
 * module-level singleton (persists across tests + requires a real file path).
 *
 * The schema mirrors `packages/memory/src/database.ts` migrations 003 + 004.
 * If those migrations drift, the schema.test.ts FX-25 test catches it; this
 * helper exists only so per-test DBs start fresh and isolated.
 */

import { Database } from 'bun:sqlite';

const CRYSTALLIZATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS crystallizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('procedure', 'episode', 'skill_execution', 'mixed')),
  source_ids TEXT NOT NULL,
  source_signature TEXT NOT NULL UNIQUE,
  weighted_score REAL NOT NULL,
  draft_path TEXT NOT NULL,
  promoted_path TEXT,
  eval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(eval_status IN ('pending', 'mechanical_pass', 'mechanical_fail', 'replay_pass', 'replay_fail', 'mechanical_only', 'complete')),
  approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(approval_status IN ('pending', 'approved', 'rejected', 'expired')),
  approval_token_prefix_8 TEXT,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron', 'event_hook', 'manual')),
  llm_cost_usd REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  evaluated_at INTEGER,
  approved_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crystallization_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crystallization_id TEXT NOT NULL REFERENCES crystallizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN
    ('created', 'mechanical_eval', 'replay_eval', 'email_sent', 'approved',
     'rejected', 'expired', 'promoted', 'reverted', 'threshold_changed')),
  payload TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_crystallizations_status ON crystallizations(eval_status, approval_status);
CREATE INDEX IF NOT EXISTS idx_crystallizations_slug ON crystallizations(slug);
CREATE INDEX IF NOT EXISTS idx_crystallizations_expires ON crystallizations(expires_at) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crystallization_events_id ON crystallization_events(crystallization_id, created_at);
`;

export function freshCrystallizationsDb(): Database {
  const db = new Database(':memory:');
  db.exec(CRYSTALLIZATIONS_SCHEMA);
  return db;
}
