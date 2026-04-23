import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  blendEmbeddings,
  generateEmbedding,
  throttleMetrics,
  resetThrottleState,
} from '../embeddings.js';
import type { MemoryConfig } from 'zouroboros-core';

describe('cosineSimilarity', () => {
  test('identical vectors return 1', () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test('orthogonal vectors return 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  test('opposite vectors return -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  test('throws on mismatched dimensions', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('same length');
  });
});

describe('serializeEmbedding / deserializeEmbedding', () => {
  test('round-trips embedding data', () => {
    const original = [0.1, 0.2, 0.3, -0.5, 1.0];
    const serialized = serializeEmbedding(original);
    const deserialized = deserializeEmbedding(serialized);

    expect(deserialized.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(deserialized[i]).toBeCloseTo(original[i], 5);
    }
  });

  test('handles empty embeddings', () => {
    const serialized = serializeEmbedding([]);
    const deserialized = deserializeEmbedding(serialized);
    expect(deserialized).toEqual([]);
  });
});

describe('blendEmbeddings', () => {
  test('default 40/60 blend', () => {
    const a = [1.0, 0.0, 0.0];
    const b = [0.0, 1.0, 0.0];
    const blended = blendEmbeddings(a, b);
    expect(blended[0]).toBeCloseTo(0.4, 5);
    expect(blended[1]).toBeCloseTo(0.6, 5);
    expect(blended[2]).toBeCloseTo(0.0, 5);
  });

  test('equal blend with weight 0.5', () => {
    const a = [2.0, 0.0];
    const b = [0.0, 4.0];
    const blended = blendEmbeddings(a, b, 0.5);
    expect(blended[0]).toBeCloseTo(1.0, 5);
    expect(blended[1]).toBeCloseTo(2.0, 5);
  });

  test('weight 1.0 returns first embedding', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const blended = blendEmbeddings(a, b, 1.0);
    expect(blended).toEqual([1, 2, 3]);
  });

  test('weight 0.0 returns second embedding', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const blended = blendEmbeddings(a, b, 0.0);
    expect(blended).toEqual([4, 5, 6]);
  });

  test('throws on mismatched dimensions', () => {
    expect(() => blendEmbeddings([1], [1, 2])).toThrow('same dimension');
  });
});

// ─── ECC-010: Memory Explosion Throttling ────────────────────────────────────

const MOCK_EMBEDDING = [0.1, 0.2, 0.3];
const BASE_CONFIG: MemoryConfig = {
  vectorEnabled: true,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'nomic-embed-text',
  embeddingProvider: 'ollama',
  dbPath: ':memory:',
  maxMemories: 1000,
  decayEnabled: false,
  decayHalfLifeDays: 30,
};

const OPENAI_CONFIG: MemoryConfig = {
  ...BASE_CONFIG,
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimension: 1536,
};

// Patch global fetch for embedding tests
let fetchCallCount = 0;
const originalFetch = globalThis.fetch;

function mockOllamaFetch(): void {
  globalThis.fetch = async (_url: string | URL | Request, _opts?: RequestInit) => {
    fetchCallCount++;
    return new Response(JSON.stringify({ embedding: MOCK_EMBEDDING }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe('ECC-010: Memory Explosion Throttling', () => {
  beforeEach(() => {
    resetThrottleState();
    fetchCallCount = 0;
    mockOllamaFetch();
  });

  test('normal flow — first call hits Ollama', async () => {
    const result = await generateEmbedding('hello world', BASE_CONFIG, 'conv-001');
    expect(result).toEqual(MOCK_EMBEDDING);
    expect(fetchCallCount).toBe(1);
    expect(throttleMetrics.dedupCount).toBe(0);
    expect(throttleMetrics.throttleCount).toBe(0);
    restoreFetch();
  });

  test('dedup hit — same content within cooldown skips Ollama', async () => {
    await generateEmbedding('deduplicate me', BASE_CONFIG, 'conv-002');
    const result = await generateEmbedding('deduplicate me', BASE_CONFIG, 'conv-002');
    expect(result).toEqual(MOCK_EMBEDDING);
    expect(fetchCallCount).toBe(1); // second call served from cache
    expect(throttleMetrics.dedupCount).toBe(1);
    restoreFetch();
  });

  test('rate limit trigger — 21st call in same window returns tail sample', async () => {
    const convId = 'conv-rate-limited';
    // Exhaust the 20-per-minute budget
    for (let i = 0; i < 20; i++) {
      await generateEmbedding(`unique content ${i}`, BASE_CONFIG, convId);
    }
    expect(throttleMetrics.throttleCount).toBe(0);

    // 21st call should be throttled
    const result = await generateEmbedding('unique content 21', BASE_CONFIG, convId);
    expect(throttleMetrics.throttleCount).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING); // tail sample from last produced embedding
    expect(fetchCallCount).toBe(20); // 21st did NOT hit Ollama
    restoreFetch();
  });

  test('no conversationId — bypasses throttling entirely', async () => {
    for (let i = 0; i < 25; i++) {
      await generateEmbedding(`bypass content ${i}`, BASE_CONFIG);
    }
    expect(fetchCallCount).toBe(25); // all 25 hit Ollama
    expect(throttleMetrics.throttleCount).toBe(0);
    expect(throttleMetrics.dedupCount).toBe(0);
    restoreFetch();
  });

  test('throttleMetrics.dedupCount and throttleCount exported correctly', async () => {
    const convId = 'conv-metrics';
    await generateEmbedding('same text', BASE_CONFIG, convId);
    await generateEmbedding('same text', BASE_CONFIG, convId); // dedup
    expect(throttleMetrics.dedupCount).toBe(1);
    expect(throttleMetrics.throttleCount).toBe(0);
    restoreFetch();
  });
});

// ─── OpenAI provider routing ─────────────────────────────────────────────────

describe('OpenAI embedding provider', () => {
  const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    resetThrottleState();
    process.env.OPENAI_API_KEY = 'sk-test-key';
  });

  test('routes to OpenAI endpoint and parses data[0].embedding', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedBody = opts?.body ? JSON.parse(opts.body as string) : null;
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.7, 0.8, 0.9], index: 0 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const result = await generateEmbedding('hello', OPENAI_CONFIG);
    expect(capturedUrl).toBe('https://api.openai.com/v1/embeddings');
    expect((capturedBody as { model: string }).model).toBe('text-embedding-3-small');
    expect((capturedBody as { dimensions: number }).dimensions).toBe(1536);
    expect(result).toEqual([0.7, 0.8, 0.9]);

    restoreFetch();
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  });

  test('throws when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ZO_OPENAI_API_KEY;
    await expect(generateEmbedding('hi', OPENAI_CONFIG)).rejects.toThrow('OPENAI_API_KEY');
    if (ORIGINAL_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  });
});
