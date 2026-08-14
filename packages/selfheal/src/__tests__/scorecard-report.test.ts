import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('scorecard report activation watchlist', () => {
  test('separates orphan activation rows from live-fact coverage', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'scorecard-report-'));
    tempDirs.push(workspace);
    const snapshotDir = join(workspace, '.zo/selfheal');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'scorecard-1000.json'), JSON.stringify({
      timestamp: '2026-07-22T00:00:00.000Z',
      composite: 1,
      metrics: [],
      weakest: 'none',
      topOpportunities: [],
    }));

    const dbPath = join(workspace, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE facts(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE unified_activation(fact_id TEXT PRIMARY KEY, calculated_at INTEGER);
    `);
    const recent = Math.floor(Date.now() / 1000);
    for (const id of ['live-1', 'live-2', 'live-3']) {
      db.query('INSERT INTO facts(id, created_at) VALUES(?, ?)').run(id, recent - 86400);
      db.query('INSERT INTO unified_activation(fact_id, calculated_at) VALUES(?, ?)').run(id, recent);
    }
    db.query('INSERT INTO unified_activation(fact_id, calculated_at) VALUES(?, ?)').run('orphan-1', recent - 1000000);
    db.query('INSERT INTO unified_activation(fact_id, calculated_at) VALUES(?, ?)').run('orphan-2', recent - 1000000);
    db.close();

    const script = join(import.meta.dir, '../../scripts/scorecard-report.ts');
    const proc = Bun.spawnSync(['bun', script, '--json'], {
      env: { ...process.env, ZO_WORKSPACE: workspace, ZOUROBOROS_MEMORY_DB: dbPath },
    });
    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(proc.stdout.toString()) as { openItems: Array<{ summary: string }> };
    const item = report.openItems.find((entry) => entry.summary.includes('unified_activation'));

    expect(item?.summary).toContain('3/3 live facts covered');
    expect(item?.summary).toContain('0 recent live facts await');
    expect(item?.summary).toContain('2 orphan activation rows');
    expect(item?.summary).toContain('do not indicate a recompute freeze');
  });

  test('treats newly created facts as pending the next recompute', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'scorecard-report-'));
    tempDirs.push(workspace);
    const snapshotDir = join(workspace, '.zo/selfheal');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'scorecard-1000.json'), JSON.stringify({
      timestamp: '2026-07-22T00:00:00.000Z',
      composite: 1,
      metrics: [],
      weakest: 'none',
      topOpportunities: [],
    }));

    const dbPath = join(workspace, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE facts(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE unified_activation(fact_id TEXT PRIMARY KEY, calculated_at INTEGER);
    `);
    const recent = Math.floor(Date.now() / 1000);
    db.query('INSERT INTO facts(id, created_at) VALUES(?, ?)').run('new-live', recent);
    db.close();

    const script = join(import.meta.dir, '../../scripts/scorecard-report.ts');
    const proc = Bun.spawnSync(['bun', script, '--json'], {
      env: { ...process.env, ZO_WORKSPACE: workspace, ZOUROBOROS_MEMORY_DB: dbPath },
    });
    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(proc.stdout.toString()) as { openItems: Array<{ severity: string; summary: string }> };
    const item = report.openItems.find((entry) => entry.summary.includes('unified_activation'));

    expect(item?.severity).toBe('low');
    expect(item?.summary).toContain('1 recent live facts await the next daily recompute');
  });
});
