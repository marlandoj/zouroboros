import { describe, expect, test } from 'bun:test';
import { detectHarness, loadHarnessContract, resolvePortableHarness, validateHarnessContract } from '../executor/portability.js';

describe('portable harness contract', () => {
  const contract = loadHarnessContract();

  test('detects all five supported harnesses with deterministic precedence', () => {
    expect(detectHarness(contract, { explicitHarness: 'claude' })).toBe('claude-code');
    expect(detectHarness(contract, { env: { CODEX_HOME: '/tmp/codex' }, argv: ['gemini'] })).toBe('codex');
    expect(detectHarness(contract, { argv: ['/usr/bin/cursor-agent'], env: {} })).toBe('cursor');
    expect(detectHarness(contract, { argv: ['gemini-cli'], env: {} })).toBe('gemini');
    expect(detectHarness(contract, { argv: ['hermes-agent'], env: {} })).toBe('hermes');
  });

  test('fails closed for unknown, ambiguous, and malformed inputs', () => {
    expect(() => detectHarness(contract, { explicitHarness: 'unknown' })).toThrow('Unsupported harness');
    expect(() => detectHarness(contract, { env: { CODEX_HOME: '1', HERMES_HOME: '1' }, argv: [] })).toThrow('Ambiguous');
    expect(() => detectHarness(contract, { env: {}, argv: ['node'] })).toThrow('Unable to detect');
    expect(() => validateHarnessContract({ ...contract, extra: true })).toThrow('unknown fields');
    const malformed = structuredClone(contract) as unknown as Record<string, unknown>;
    delete ((malformed.harnesses as Record<string, Record<string, unknown>>).codex.tools as Record<string, unknown>).web;
    expect(() => validateHarnessContract(malformed)).toThrow('Tool map for codex is incomplete');
    expect(() => resolvePortableHarness({ explicitHarness: 'codex', contractPath: 'missing.json' })).toThrow('not found');
  });

  test('resolves registry-backed overlays and explicit unsupported tools', () => {
    for (const id of ['claude-code', 'codex', 'cursor', 'gemini', 'hermes']) {
      const resolved = resolvePortableHarness({ explicitHarness: id });
      expect(resolved.executor.id).toBe(id);
      expect(resolved.overlay.transport).toBe(resolved.executor.transport);
      expect(Object.keys(resolved.tools).sort()).toEqual(['mcp', 'read', 'shell', 'web', 'write']);
    }
    expect(resolvePortableHarness({ explicitHarness: 'codex' }).tools.web).toBeNull();
  });
});
