/**
 * FX-25 — schema migrations are idempotent across reruns.
 *
 * Imports `runMigrations` from zouroboros-memory and runs it twice against a
 * fresh tmp DB. Asserts both tables + indexes exist and a second invocation
 * is a no-op (no duplicate _migrations rows, no schema drift).
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
// Import directly from memory's source so the test exercises the in-tree
// schema changes without depending on a fresh dist/ build.
import {
  closeDatabase,
  initDatabase,
  isInitialized,
  runMigrations,
} from '../../../../memory/src/database.js';

const FIX = join(import.meta.dir, '..', 'fixtures', 'crystallize');

describe('crystallize/schema (FX-25)', () => {
  test('runMigrations is idempotent and creates crystallization tables', () => {
    const fx = JSON.parse(
      readFileSync(join(FIX, 'FX-25-schema-idempotent-rerun.json'), 'utf8'),
    );
    const tmp = mkdtempSync(join(tmpdir(), 'crystallize-fx25-'));
    const dbPath = join(tmp, 'shared-facts.db');

    try {
      // Reset module-level singleton.
      if (isInitialized()) closeDatabase();

      runMigrations({ dbPath } as any);
      // Second invocation should not throw and should not duplicate rows.
      runMigrations({ dbPath } as any);

      const db: Database = initDatabase({ dbPath } as any);
      const tables = (db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]).map((r) => r.name);

      for (const required of fx.expected.tablesPresent) {
        expect(tables).toContain(required);
      }

      const applied = (db
        .query('SELECT COUNT(*) as count FROM _migrations')
        .get() as { count: number }).count;
      expect(applied).toBe(fx.expected.appliedRowCountAfterDouble);

      // Indexes for crystallizations are present.
      const indexes = (db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('crystallizations', 'crystallization_events')",
        )
        .all() as { name: string }[]).map((r) => r.name);
      expect(indexes).toContain('idx_crystallizations_status');
      expect(indexes).toContain('idx_crystallizations_slug');
      expect(indexes).toContain('idx_crystallizations_expires');
      expect(indexes).toContain('idx_crystallization_events_id');

      closeDatabase();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
