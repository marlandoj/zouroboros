import { test, expect, describe, mock, beforeAll } from 'bun:test';
import { MimirTransport } from '../transport/mimir-transport.js';
import type { Task } from '../types.js';
import type { TransportOptions } from '../transport/types.js';

function makeTask(taskText: string = 'What do we know about the auth middleware?'): Task {
  return {
    id: 'sage-test-1',
    persona: 'mimir',
    task: taskText,
    priority: 'high',
    role: 'memory-sage',
  };
}

const defaultOptions: TransportOptions = { timeoutMs: 15000 };

describe('MimirTransport', () => {
  test('returns success with synthesis when gate finds context', async () => {
    // Mock fetch to simulate gate response with synthesis
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/gate')) {
        return new Response(JSON.stringify({
          exit_code: 0,
          method: 'keyword_heuristic',
          output: '[Mimir Synthesis]\nThe auth middleware was redesigned for compliance in March 2026.',
          latency_ms: 2500,
        }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const result = await transport.execute(makeTask(), defaultOptions);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Mimir Synthesis');
    expect(result.output).toContain('auth middleware');
    expect(result.effectiveExecutor).toBe('mimir');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    globalThis.fetch = originalFetch;
  });

  test('returns graceful "no context" on exit_code 2 (skip)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        exit_code: 2,
        method: 'keyword_heuristic',
        output: '',
        latency_ms: 5,
      }), { status: 200 });
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const result = await transport.execute(makeTask('hello'), defaultOptions);

    expect(result.success).toBe(true);
    expect(result.output).toContain('No relevant historical context');

    globalThis.fetch = originalFetch;
  });

  test('returns graceful "no context" on exit_code 3 (needed-but-empty)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        exit_code: 3,
        method: 'ollama_classifier',
        output: '',
        latency_ms: 500,
      }), { status: 200 });
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const result = await transport.execute(makeTask('quantum chromodynamics'), defaultOptions);

    expect(result.success).toBe(true);
    expect(result.output).toContain('No relevant historical context');

    globalThis.fetch = originalFetch;
  });

  test('returns failure on HTTP error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const result = await transport.execute(makeTask(), defaultOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');

    globalThis.fetch = originalFetch;
  });

  test('returns failure on network error', async () => {
    const transport = new MimirTransport('http://localhost:99999');
    const result = await transport.execute(makeTask(), { timeoutMs: 2000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Mimir gate error');
  });

  test('healthCheck reports mimir backend status', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/health')) {
        return new Response(JSON.stringify({
          status: 'ok',
          backends: {
            mimir: { exists: true, facts: 705 },
          },
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const health = await transport.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.message).toContain('705 facts');

    globalThis.fetch = originalFetch;
  });

  test('healthCheck reports unhealthy when mimir backend missing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        status: 'ok',
        backends: {},
      }), { status: 200 });
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const health = await transport.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.message).toContain('not configured');

    globalThis.fetch = originalFetch;
  });

  test('executeWithUpdates returns empty updates + result promise', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        exit_code: 0,
        method: 'keyword_heuristic',
        output: '[Mimir Synthesis]\nTest synthesis',
        latency_ms: 100,
      }), { status: 200 });
    }) as typeof fetch;

    const transport = new MimirTransport('http://localhost:7820');
    const { updates, result } = transport.executeWithUpdates(makeTask(), defaultOptions);

    // Updates should be empty
    const collected: any[] = [];
    for await (const u of updates) {
      collected.push(u);
    }
    expect(collected).toHaveLength(0);

    // Result should resolve
    const r = await result;
    expect(r.success).toBe(true);

    globalThis.fetch = originalFetch;
  });
});
