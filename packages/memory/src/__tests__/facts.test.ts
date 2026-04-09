import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '../database.js';
import { storeFact, searchFacts, getFact, deleteFact } from '../facts.js';
import type { MemoryConfig } from 'zouroboros-core';

const TEST_CONFIG: MemoryConfig = {
  enabled: true,
  dbPath: ':memory:',
  vectorEnabled: false,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'nomic-embed-text',
  autoCapture: false,
  captureIntervalMinutes: 30,
  graphBoost: false,
  hydeExpansion: false,
  decayConfig: { permanent: 99999, long: 365, medium: 90, short: 30 },
};

beforeEach(() => {
  initDatabase(TEST_CONFIG);
});

afterEach(() => {
  closeDatabase();
});

describe('storeFact', () => {
  test('stores a fact with default persona "shared"', async () => {
    const entry = await storeFact({
      entity: 'test.entity',
      value: 'test value',
    }, TEST_CONFIG);

    expect(entry.id).toBeDefined();
    expect(entry.entity).toBe('test.entity');

    const results = searchFacts('test value');
    expect(results.length).toBe(1);
  });

  test('stores a fact with explicit persona', async () => {
    await storeFact({
      entity: 'project.zouroboros',
      value: 'uses Bun runtime',
      persona: 'alaric',
    }, TEST_CONFIG);

    await storeFact({
      entity: 'project.ffb',
      value: 'uses Shopify',
      persona: 'financial-advisor',
    }, TEST_CONFIG);

    const results = searchFacts('uses', { persona: 'alaric' });
    expect(results.length).toBe(1);
    expect(results[0].entity).toBe('project.zouroboros');
  });

  test('persona filter includes shared facts', async () => {
    await storeFact({
      entity: 'user.preference',
      value: 'prefers dark mode',
      persona: 'shared',
    }, TEST_CONFIG);

    await storeFact({
      entity: 'project.zouroboros',
      value: 'prefers Bun over Node',
      persona: 'alaric',
    }, TEST_CONFIG);

    const results = searchFacts('prefers', { persona: 'alaric' });
    expect(results.length).toBe(2);
  });

  test('persona filter excludes other persona facts', async () => {
    await storeFact({
      entity: 'project.ffb',
      value: 'secret FFB data',
      persona: 'financial-advisor',
    }, TEST_CONFIG);

    const results = searchFacts('FFB', { persona: 'alaric' });
    expect(results.length).toBe(0);
  });

  test('no persona filter returns all facts', async () => {
    await storeFact({ entity: 'a', value: 'fact one', persona: 'alaric' }, TEST_CONFIG);
    await storeFact({ entity: 'b', value: 'fact two', persona: 'financial-advisor' }, TEST_CONFIG);
    await storeFact({ entity: 'c', value: 'fact three', persona: 'shared' }, TEST_CONFIG);

    const results = searchFacts('fact');
    expect(results.length).toBe(3);
  });
});

describe('getFact / deleteFact', () => {
  test('retrieves a stored fact by ID', async () => {
    const entry = await storeFact({
      entity: 'test.entity',
      value: 'retrievable value',
    }, TEST_CONFIG);

    const found = getFact(entry.id);
    expect(found).not.toBeNull();
    expect(found!.value).toBe('retrievable value');
  });

  test('deletes a fact by ID', async () => {
    const entry = await storeFact({
      entity: 'test.entity',
      value: 'deletable value',
    }, TEST_CONFIG);

    const deleted = deleteFact(entry.id);
    expect(deleted).toBe(true);
    expect(getFact(entry.id)).toBeNull();
  });
});
