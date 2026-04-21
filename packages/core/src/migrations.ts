/**
 * Versioned database migration system for Zouroboros.
 *
 * Migrations are defined as numbered entries with up/down SQL.
 * The system tracks which migrations have been applied in a
 * `_migrations` table and applies them in order.
 */

export interface Migration {
  id: number;
  name: string;
  up: string;
  down: string;
}

export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: number;
}

export interface MigrationStatus {
  applied: MigrationRecord[];
  pending: Migration[];
  current: number; // highest applied migration ID, 0 if none
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  errors: { name: string; error: string }[];
}

/**
 * Built-in migrations registry.
 * New migrations are appended here with incrementing IDs.
 * IDs must be sequential and never reused.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: '001_add_migrations_table',
    up: `
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
    `,
    down: `DROP TABLE IF EXISTS _migrations;`,
  },
  {
    id: 2,
    name: '002_add_facts_persona_index',
    up: `CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);`,
    down: `DROP INDEX IF EXISTS idx_facts_persona;`,
  },
  {
    id: 3,
    name: '003_add_facts_confidence_index',
    up: `CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts(confidence);`,
    down: `DROP INDEX IF EXISTS idx_facts_confidence;`,
  },
  {
    id: 4,
    name: '004_add_episodes_procedure_index',
    up: `CREATE INDEX IF NOT EXISTS idx_episodes_procedure ON episodes(procedure_id);`,
    down: `DROP INDEX IF EXISTS idx_episodes_procedure;`,
  },
  {
    id: 5,
    name: '005_add_open_loops_priority_index',
    up: `CREATE INDEX IF NOT EXISTS idx_open_loops_priority ON open_loops(priority, status);`,
    down: `DROP INDEX IF EXISTS idx_open_loops_priority;`,
  },
  // -----------------------------------------------------------------
  // Migrations 6-12 (see issues #69, #70): bring any DB to the full
  // schema needed by standalone scripts. Before these, `zouroboros init`
  // + `migrate up` produced only 9 tables; standalone hybrid search,
  // graph traversal, continuation, and FTS lookups would silently
  // create their own subset lazily or fail outright.
  // -----------------------------------------------------------------
  {
    id: 6,
    name: '006_upgrade_open_loops_to_continuation_schema',
    // Rebuild `open_loops` to match the 14-column schema that
    // standalone `continuation.ts#ensureContinuationSchema` expects.
    // Safe for fresh DBs (rebuild is a no-op if the 7-column table is
    // empty) and for DBs with existing rows (we migrate matching
    // columns and synthesise reasonable defaults for the new ones).
    up: `
      ALTER TABLE open_loops RENAME TO open_loops_v1;

      CREATE TABLE open_loops (
        id TEXT PRIMARY KEY,
        persona TEXT NOT NULL DEFAULT 'shared',
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','bug','incident','approval','commitment','other')),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','stale','superseded')),
        priority REAL DEFAULT 0.6,
        entity TEXT,
        source TEXT,
        related_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
        fingerprint TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now')),
        resolved_at INTEGER
      );

      INSERT INTO open_loops (
        id, persona, title, summary, kind, status, priority, entity,
        fingerprint, created_at, updated_at, resolved_at
      )
      SELECT
        id,
        'shared' AS persona,
        summary AS title,
        summary,
        'task' AS kind,
        CASE WHEN status IN ('open','resolved','stale','superseded') THEN status ELSE 'open' END,
        CAST(COALESCE(priority, 1) AS REAL) / 5.0,
        entity,
        id AS fingerprint,
        created_at,
        created_at,
        resolved_at
      FROM open_loops_v1;

      DROP TABLE open_loops_v1;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_open_loops_active_fingerprint
        ON open_loops(fingerprint, status);
      CREATE INDEX IF NOT EXISTS idx_open_loops_status_updated
        ON open_loops(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_open_loops_entity
        ON open_loops(entity);
      CREATE INDEX IF NOT EXISTS idx_open_loops_persona
        ON open_loops(persona);
      CREATE INDEX IF NOT EXISTS idx_open_loops_priority
        ON open_loops(priority, status);
    `,
    down: `
      ALTER TABLE open_loops RENAME TO open_loops_v2;
      CREATE TABLE open_loops (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        entity TEXT NOT NULL,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
        priority INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        resolved_at INTEGER
      );
      INSERT INTO open_loops (id, summary, entity, status, priority, created_at, resolved_at)
      SELECT
        id,
        summary,
        COALESCE(entity, '') AS entity,
        CASE WHEN status IN ('open','resolved') THEN status ELSE 'open' END,
        CAST(priority * 5 AS INTEGER),
        created_at,
        resolved_at
      FROM open_loops_v2;
      DROP TABLE open_loops_v2;
      CREATE INDEX IF NOT EXISTS idx_open_loops_entity ON open_loops(entity, status);
      CREATE INDEX IF NOT EXISTS idx_open_loops_priority ON open_loops(priority, status);
    `,
  },
  {
    id: 7,
    name: '007_add_fact_links',
    up: `
      CREATE TABLE IF NOT EXISTS fact_links (
        source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        PRIMARY KEY (source_id, target_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
      CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_fact_links_target;
      DROP INDEX IF EXISTS idx_fact_links_source;
      DROP TABLE IF EXISTS fact_links;
    `,
  },
  {
    id: 8,
    name: '008_add_procedure_episodes',
    up: `
      CREATE TABLE IF NOT EXISTS procedure_episodes (
        procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        PRIMARY KEY (procedure_id, episode_id)
      );
    `,
    down: `DROP TABLE IF EXISTS procedure_episodes;`,
  },
  {
    id: 9,
    name: '009_add_episode_documents_and_fts',
    up: `
      CREATE TABLE IF NOT EXISTS episode_documents (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
        episode_id UNINDEXED,
        text
      );
    `,
    down: `
      DROP TABLE IF EXISTS episode_documents_fts;
      DROP TABLE IF EXISTS episode_documents;
    `,
  },
  {
    id: 10,
    name: '010_add_open_loops_fts',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS open_loops_fts USING fts5(
        loop_id UNINDEXED,
        text
      );
    `,
    down: `DROP TABLE IF EXISTS open_loops_fts;`,
  },
  {
    id: 11,
    name: '011_add_facts_fts',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        fact_id UNINDEXED,
        text,
        entity UNINDEXED,
        content='facts',
        content_rowid='rowid'
      );
      INSERT INTO facts_fts(rowid, fact_id, text, entity)
        SELECT rowid, id, text, entity FROM facts;
    `,
    down: `DROP TABLE IF EXISTS facts_fts;`,
  },
  {
    id: 12,
    name: '012_add_capture_log',
    up: `
      CREATE TABLE IF NOT EXISTS capture_log (
        source_hash TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        captured_at INTEGER DEFAULT (strftime('%s','now')),
        fact_count INTEGER DEFAULT 0,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_capture_log_captured_at
        ON capture_log(captured_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_capture_log_captured_at;
      DROP TABLE IF EXISTS capture_log;
    `,
  },
];

export interface MigrationRunner {
  ensureMigrationsTable(): void;
  getApplied(): MigrationRecord[];
  getStatus(): MigrationStatus;
  migrate(targetId?: number): MigrationResult;
  rollback(targetId: number): MigrationResult;
}

/**
 * Create a migration runner for a given database.
 * The `db` parameter must support `.exec(sql)`, `.query(sql).all()`,
 * and `.run(sql, params)` — matching bun:sqlite's Database API.
 */
export function createMigrationRunner(db: {
  exec(sql: string): void;
  query(sql: string): { all(): unknown[] };
  run(sql: string, params?: unknown[]): void;
}): MigrationRunner {
  function ensureMigrationsTable(): void {
    db.exec(MIGRATIONS[0].up);
  }

  function getApplied(): MigrationRecord[] {
    ensureMigrationsTable();
    return db.query('SELECT id, name, applied_at FROM _migrations ORDER BY id')
      .all() as MigrationRecord[];
  }

  function getStatus(): MigrationStatus {
    const applied = getApplied();
    const appliedIds = new Set(applied.map((m) => m.id));
    const pending = MIGRATIONS.filter((m) => !appliedIds.has(m.id));
    const current = applied.length > 0 ? Math.max(...applied.map((m) => m.id)) : 0;
    return { applied, pending, current };
  }

  function migrate(targetId?: number): MigrationResult {
    const { pending } = getStatus();
    const target = targetId ?? Math.max(...MIGRATIONS.map((m) => m.id));
    const toApply = pending
      .filter((m) => m.id <= target)
      .sort((a, b) => a.id - b.id);

    const result: MigrationResult = { applied: [], skipped: [], errors: [] };

    for (const migration of toApply) {
      try {
        db.exec(migration.up);
        db.run(
          'INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)',
          [migration.id, migration.name]
        );
        result.applied.push(migration.name);
      } catch (err) {
        result.errors.push({
          name: migration.name,
          error: err instanceof Error ? err.message : String(err),
        });
        break; // stop on first error
      }
    }

    return result;
  }

  function rollback(targetId: number): MigrationResult {
    const { applied } = getStatus();
    const toRollback = applied
      .filter((m) => m.id > targetId)
      .sort((a, b) => b.id - a.id); // reverse order

    const result: MigrationResult = { applied: [], skipped: [], errors: [] };

    for (const record of toRollback) {
      const migration = MIGRATIONS.find((m) => m.id === record.id);
      if (!migration) {
        result.skipped.push(`${record.name} (no migration definition found)`);
        continue;
      }

      try {
        db.exec(migration.down);
        db.run('DELETE FROM _migrations WHERE id = ?', [migration.id]);
        result.applied.push(migration.name);
      } catch (err) {
        result.errors.push({
          name: migration.name,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    return result;
  }

  return { ensureMigrationsTable, getApplied, getStatus, migrate, rollback };
}
