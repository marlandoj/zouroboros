import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Build the fixture and point the env at it BEFORE importing the collector, whose
// module-level MEMORY_DB constant is captured at first import. No static collector
// import appears in this file, so the dynamic import below resolves the fixture.
const dir = mkdtempSync(join(tmpdir(), 'chunk-health-metric-'));
const dbPath = join(dir, 'memory.db');
process.env.ZOUROBOROS_MEMORY_DB = dbPath;
process.env.ZO_MEMORY_DB = '';

const MIN_FACTS = 100;
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE facts(id TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE chunk_quality(
    id TEXT PRIMARY KEY, collection TEXT NOT NULL, point_id TEXT NOT NULL,
    icc REAL, dcc REAL, chunk_chars INTEGER, sample_size INTEGER,
    measured_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
const insertFact = db.query('INSERT INTO facts(id, value) VALUES(?, ?)');
for (let i = 0; i < MIN_FACTS; i++) insertFact.run(`f${i}`, `fact ${i}`);
const now = Math.floor(Date.now() / 1000);
const seedRows = [
  { collection: 'zouroboros-code', icc: 0.7, dcc: 0.64 },
  { collection: 'zouroboros-research', icc: 0.68, dcc: 0.61 },
  { collection: 'code-docs', icc: 0.41, dcc: 0.40 }, // snippet store — excluded
];
for (const [index, row] of seedRows.entries()) {
  db.query(
    'INSERT INTO chunk_quality(id, collection, point_id, icc, dcc, chunk_chars, sample_size, measured_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(`id-${index}`, row.collection, `p-${index}`, row.icc, row.dcc, 500, 3, now);
}
db.close();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('measureChunkHealth snippet-store exclusion', () => {
  test('excludes the code-docs snippet store from the composite and reports it', async () => {
    const { measureChunkHealth } = await import('../introspect/collector.ts');
    const result = await measureChunkHealth();

    // Composite of only the two genuinely-chunked collections.
    const expected = ((0.7 + 0.68) / 2 + (0.64 + 0.61) / 2) / 2;
    expect(result.value).toBeCloseTo(expected, 3);
    expect(result.value).toBeGreaterThan(0.55);
    expect(result.detail).toContain('excluded snippet-store(s): code-docs');
    expect(result.detail).not.toContain('0.41');
  });
});
