import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createEpisode } from '../episodes.js';
import { initDatabase, closeDatabase, getDatabase } from '../database.js';
import type { MemoryConfig } from 'zouroboros-core';

const TEST_CONFIG: MemoryConfig = {
  enabled: true,
  dbPath: ':memory:',
  vectorEnabled: false,
  autoCapture: false,
  captureIntervalMinutes: 30,
  graphBoost: false,
  hydeExpansion: false,
  decayConfig: { permanent: 99999, long: 365, medium: 90, short: 30 },
};

const SAVED_TRACE = process.env.ZO_TRACE_ID;

beforeEach(() => {
  initDatabase(TEST_CONFIG);
});

afterEach(() => {
  closeDatabase();
  if (SAVED_TRACE === undefined) delete process.env.ZO_TRACE_ID;
  else process.env.ZO_TRACE_ID = SAVED_TRACE;
});

describe('createEpisode trace_id propagation (Q2 #1 Cycle B)', () => {
  test('writes trace_id to metadata when ZO_TRACE_ID is set', () => {
    const traceId = '11111111-2222-3333-4444-555555555555';
    process.env.ZO_TRACE_ID = traceId;

    const ep = createEpisode({
      summary: 'trace test episode',
      outcome: 'success',
      entities: ['trace-test'],
    });

    const db = getDatabase();
    const row = db.query('SELECT metadata FROM episodes WHERE id = ?').get(ep.id) as { metadata: string };
    expect(row.metadata).toBeTruthy();
    const meta = JSON.parse(row.metadata);
    expect(meta.trace_id).toBe(traceId);
  });

  test('preserves caller metadata alongside trace_id', () => {
    const traceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    process.env.ZO_TRACE_ID = traceId;

    const ep = createEpisode({
      summary: 'merge test',
      outcome: 'success',
      entities: ['merge-test'],
      metadata: { source: 'unit-test', priority: 'high' },
    });

    const db = getDatabase();
    const row = db.query('SELECT metadata FROM episodes WHERE id = ?').get(ep.id) as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.trace_id).toBe(traceId);
    expect(meta.source).toBe('unit-test');
    expect(meta.priority).toBe('high');
  });

  test('writes null metadata when neither trace_id nor caller metadata present', () => {
    delete process.env.ZO_TRACE_ID;

    const ep = createEpisode({
      summary: 'no metadata',
      outcome: 'success',
      entities: ['none'],
    });

    const db = getDatabase();
    const row = db.query('SELECT metadata FROM episodes WHERE id = ?').get(ep.id) as { metadata: string | null };
    expect(row.metadata).toBeNull();
  });

  test('indexes the episode summary for retrieval', () => {
    const ep = createEpisode({
      summary: 'retrieval-indexed episode',
      outcome: 'success',
      entities: ['index-test'],
      metadata: { source: 'unit-test' },
    });

    const db = getDatabase();
    const document = db.query('SELECT text FROM episode_documents WHERE episode_id = ?').get(ep.id) as { text: string };
    const hit = db.query('SELECT episode_id FROM episode_documents_fts WHERE episode_documents_fts MATCH ?').get('retrieval') as { episode_id: string };
    expect(document.text).toContain('retrieval-indexed episode');
    expect(document.text).toContain('index-test');
    expect(hit.episode_id).toBe(ep.id);
  });
});
