import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Pure-function guard tests. These do not touch the module-level MEMORY_DB
// constant (isLegacyMemoryDb takes an explicit path), so a static import is safe.
import { isLegacyMemoryDb, MIN_VIABLE_FACTS } from '../introspect/collector.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(name: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), name));
  tempDirs.push(dir);
  return { dir, dbPath: join(dir, 'memory.db') };
}

describe('isLegacyMemoryDb', () => {
  test('flags a sparse facts table as the legacy default', () => {
    const { dbPath } = makeDb('legacy-db-');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE facts(id TEXT PRIMARY KEY, value TEXT)');
    db.query('INSERT INTO facts(id, value) VALUES(?, ?)').run('f1', 'stray');
    db.close();
    expect(isLegacyMemoryDb(dbPath)).toBe(true);
  });

  test('does not flag a production-scale facts table', () => {
    const { dbPath } = makeDb('prod-db-');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE facts(id TEXT PRIMARY KEY, value TEXT)');
    const insert = db.query('INSERT INTO facts(id, value) VALUES(?, ?)');
    for (let i = 0; i < MIN_VIABLE_FACTS; i++) insert.run(`f${i}`, `fact ${i}`);
    db.close();
    expect(isLegacyMemoryDb(dbPath)).toBe(false);
  });

  test('does not flag a DB with no facts table (fresh checkout) or a missing file', () => {
    const { dir, dbPath } = makeDb('fresh-db-');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE episodes(id TEXT PRIMARY KEY)');
    db.close();
    expect(isLegacyMemoryDb(dbPath)).toBe(false);
    expect(isLegacyMemoryDb(join(dir, 'missing.db'))).toBe(false);
  });
});
