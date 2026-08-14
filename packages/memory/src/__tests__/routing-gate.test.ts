import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyMemoryQuery,
  logMemoryRoute,
  getRecentRoutingDecisions,
  getRoutingDistribution,
  _resetRoutingGateCache,
} from '../routing-gate.js';

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zo-route-'));
  dbPath = join(tmpDir, 'shared-facts.db');
  // Touch the file so existsSync passes; the gate will CREATE TABLE on first call.
  execSync(`sqlite3 "${dbPath}" "CREATE TABLE IF NOT EXISTS _seed (id INTEGER);"`);
  process.env.ZOUROBOROS_MEMORY_DB = dbPath;
});

beforeEach(() => {
  execSync(`sqlite3 "${dbPath}" "DELETE FROM memory_routing_log;" 2>/dev/null || true`);
});

afterEach(() => {});

describe('classifyMemoryQuery (heuristic)', () => {
  test('procedural — how-to phrasing', () => {
    const d = classifyMemoryQuery('How do I deploy the agent?');
    expect(d.kind).toBe('procedural');
    expect(d.confidence).toBeGreaterThan(0.7);
  });

  test('procedural — steps for', () => {
    const d = classifyMemoryQuery('steps for restoring a backup');
    expect(d.kind).toBe('procedural');
  });

  test('episodic — temporal cue', () => {
    const d = classifyMemoryQuery('what happened yesterday with the PR?');
    expect(d.kind).toBe('episodic');
  });

  test('episodic — last week', () => {
    const d = classifyMemoryQuery('what did we ship last week');
    expect(d.kind).toBe('episodic');
  });

  test('semantic — fact lookup', () => {
    const d = classifyMemoryQuery('what is the email address for ops');
    expect(d.kind).toBe('semantic');
  });

  test('semantic — entity-rich default', () => {
    const d = classifyMemoryQuery('Client-B quarterly review');
    expect(d.kind).toBe('semantic');
  });

  test('parametric — short generic', () => {
    const d = classifyMemoryQuery('sql joins');
    expect(d.kind).toBe('parametric');
  });

  test('parametric — empty query', () => {
    const d = classifyMemoryQuery('');
    expect(d.kind).toBe('parametric');
  });
});

describe('logMemoryRoute + getRecentRoutingDecisions', () => {
  test('persists a routing decision', () => {
    logMemoryRoute(
      'how do I run the eval',
      { kind: 'procedural', confidence: 0.9, reason: 'how-to' },
      42,
      3,
      'mimir',
      'sess-1',
    );
    const recent = getRecentRoutingDecisions(10);
    expect(recent.length).toBeGreaterThan(0);
    const last = recent[0];
    expect(last.kind).toBe('procedural');
    expect(last.hitCount).toBe(3);
    expect(last.persona).toBe('mimir');
    expect(last.latencyMs).toBe(42);
  });

  test('quotes are escaped safely', () => {
    logMemoryRoute(
      "what's the config",
      { kind: 'semantic', confidence: 0.5, reason: "default 'fallback'" },
      10,
      0,
    );
    const recent = getRecentRoutingDecisions(5);
    expect(recent[0].query).toContain("what's");
  });
});

describe('auto-create regression (W3 lesson)', () => {
  test('routing log table is created lazily even if migration 016 never ran', () => {
    // Drop the table to simulate a DB that pre-dates migration 016.
    execSync(`sqlite3 "${dbPath}" "DROP TABLE IF EXISTS memory_routing_log;"`);
    _resetRoutingGateCache();

    // Logging must still succeed because routing-gate calls ensureRoutingTable.
    logMemoryRoute(
      'recovery test',
      { kind: 'semantic', confidence: 0.5, reason: 'regression check' },
      5,
      0,
    );

    // Verify the table now exists and contains the row.
    const out = execSync(
      `sqlite3 "${dbPath}" "SELECT COUNT(*) FROM memory_routing_log WHERE query='recovery test';"`,
      { encoding: 'utf-8' }
    ).trim();
    expect(parseInt(out, 10)).toBe(1);
  });
});

describe('getRoutingDistribution', () => {
  test('aggregates counts by kind', () => {
    logMemoryRoute('how to x', { kind: 'procedural', confidence: 0.8, reason: 'r' }, 1, 1);
    logMemoryRoute('how to y', { kind: 'procedural', confidence: 0.8, reason: 'r' }, 1, 2);
    logMemoryRoute('what is z', { kind: 'semantic', confidence: 0.5, reason: 'r' }, 1, 3);

    const dist = getRoutingDistribution();
    expect(dist.total).toBeGreaterThanOrEqual(3);
    expect(dist.byKind.procedural.count).toBeGreaterThanOrEqual(2);
    expect(dist.byKind.semantic.count).toBeGreaterThanOrEqual(1);
  });
});
