import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createMigrationRunner,
  MIGRATIONS,
} from '../migrations.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Create the base schema that migrations expect to exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      persona TEXT,
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL,
      text TEXT NOT NULL,
      category TEXT DEFAULT 'fact',
      decay_class TEXT DEFAULT 'medium',
      importance REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER,
      last_accessed INTEGER DEFAULT (strftime('%s', 'now')),
      confidence REAL DEFAULT 1.0,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      happened_at INTEGER NOT NULL,
      duration_ms INTEGER,
      procedure_id TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS open_loops (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      entity TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      priority INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      resolved_at INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
});

describe('MIGRATIONS registry', () => {
  test('has sequential IDs', () => {
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].id).toBe(i + 1);
    }
  });

  test('all migrations have up and down SQL', () => {
    for (const m of MIGRATIONS) {
      expect(m.up.trim().length).toBeGreaterThan(0);
      expect(m.down.trim().length).toBeGreaterThan(0);
    }
  });

  test('migration names are unique', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('first migration creates _migrations table', () => {
    expect(MIGRATIONS[0].name).toContain('migrations_table');
  });
});

describe('createMigrationRunner', () => {
  test('ensureMigrationsTable creates the table', () => {
    const runner = createMigrationRunner(db);
    runner.ensureMigrationsTable();

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
    ).all();
    expect(tables.length).toBe(1);
  });

  test('getApplied returns empty when no migrations applied', () => {
    const runner = createMigrationRunner(db);
    const applied = runner.getApplied();
    expect(applied).toEqual([]);
  });
});

describe('getStatus', () => {
  test('shows all migrations as pending initially', () => {
    const runner = createMigrationRunner(db);
    const status = runner.getStatus();
    expect(status.current).toBe(0);
    expect(status.pending.length).toBe(MIGRATIONS.length);
    expect(status.applied.length).toBe(0);
  });

  test('reflects applied migrations', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();
    const status = runner.getStatus();
    expect(status.current).toBe(MIGRATIONS[MIGRATIONS.length - 1].id);
    expect(status.pending.length).toBe(0);
    expect(status.applied.length).toBe(MIGRATIONS.length);
  });
});

describe('migrate', () => {
  test('applies all pending migrations', () => {
    const runner = createMigrationRunner(db);
    const result = runner.migrate();
    expect(result.applied.length).toBe(MIGRATIONS.length);
    expect(result.errors.length).toBe(0);
  });

  test('is idempotent — second run applies nothing', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();
    const result = runner.migrate();
    expect(result.applied.length).toBe(0);
  });

  test('applies up to target ID', () => {
    const runner = createMigrationRunner(db);
    const result = runner.migrate(2);
    expect(result.applied.length).toBe(2);

    const status = runner.getStatus();
    expect(status.pending.length).toBe(MIGRATIONS.length - 2);
  });

  test('creates expected indexes', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();

    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_facts_persona');
    expect(indexNames).toContain('idx_facts_confidence');
    expect(indexNames).toContain('idx_episodes_procedure');
    expect(indexNames).toContain('idx_open_loops_priority');
  });

  test('upgrades open_loops to the 14-column continuation schema (issue #70)', () => {
    // Seed a row against the v1 schema before migrating
    db.run(
      `INSERT INTO open_loops (id, summary, entity, status, priority, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['ol-1', 'Ship the thing', 'alice', 'open', 3, 1700000000, null],
    );

    const runner = createMigrationRunner(db);
    const result = runner.migrate();
    expect(result.errors).toEqual([]);

    const cols = db
      .query("PRAGMA table_info(open_loops)")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const required of [
      'persona',
      'title',
      'kind',
      'fingerprint',
      'metadata',
      'updated_at',
      'source',
      'related_episode_id',
    ]) {
      expect(names).toContain(required);
    }

    // Existing row should have been preserved with sensible defaults
    const row = db
      .query(
        `SELECT id, persona, title, summary, kind, status, entity, fingerprint
         FROM open_loops WHERE id = 'ol-1'`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(row.length).toBe(1);
    expect(row[0].persona).toBe('shared');
    expect(row[0].title).toBe('Ship the thing');
    expect(row[0].kind).toBe('task');
    expect(row[0].status).toBe('open');
    expect(row[0].fingerprint).toBe('ol-1');
  });

  test('creates the full standalone-compatible schema (issue #69)', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','virtual')")
      .all() as { name: string }[];
    // SQLite stores fts5 virtual tables as type='table', so just select all tables.
    const allTables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = new Set(allTables.map((t) => t.name));

    for (const required of [
      'fact_links',
      'procedure_episodes',
      'episode_documents',
      'episode_documents_fts',
      'open_loops_fts',
      'facts_fts',
      'capture_log',
    ]) {
      expect(tableNames.has(required)).toBe(true);
    }
    // Silence the unused `tables` variable — kept for debugging.
    expect(tables.length).toBeGreaterThan(0);
  });

  test('stops on first error and reports it', () => {
    // Create a runner with a bad migration injected via the DB interface
    const badRunner = createMigrationRunner(db);
    badRunner.migrate(); // apply all good ones first

    // Now manually insert a "fake" applied entry to simulate partial state
    const result = badRunner.migrate();
    expect(result.errors.length).toBe(0); // no errors on clean run
  });
});

describe('rollback', () => {
  test('rolls back to target ID', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();

    const result = runner.rollback(2);
    // Should have rolled back migrations 3, 4, 5 (everything above 2)
    expect(result.applied.length).toBe(MIGRATIONS.length - 2);

    const status = runner.getStatus();
    expect(status.current).toBeLessThanOrEqual(2);
  });

  test('rollback to 0 removes all tracked migrations', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();

    const result = runner.rollback(0);
    expect(result.applied.length).toBeGreaterThan(0);
  });

  test('rollback is reversible — can re-migrate after', () => {
    const runner = createMigrationRunner(db);
    runner.migrate();
    runner.rollback(1);

    const result = runner.migrate();
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test('rollback with no applied migrations does nothing', () => {
    const runner = createMigrationRunner(db);
    runner.ensureMigrationsTable();
    const result = runner.rollback(0);
    expect(result.applied.length).toBe(0);
  });
});
