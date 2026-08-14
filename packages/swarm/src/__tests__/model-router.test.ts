import { describe, expect, test } from 'bun:test';
import { resolveModelForExecutor } from '../routing/model-router.js';
import type { ExecutorRegistryEntry, Task } from '../types.js';

function task(model?: string): Task {
  return {
    id: 't1',
    persona: 'auto',
    task: 'Analyze the implementation carefully.',
    priority: 'medium',
    ...(model ? { model } : {}),
  };
}

function entry(id: string, configModel?: string): ExecutorRegistryEntry {
  return {
    id,
    name: id,
    executor: 'local',
    description: id,
    expertise: [],
    bestFor: [],
    config: { defaultTimeout: 300, ...(configModel ? { model: configModel } : {}) },
  };
}

describe('model router', () => {
  test('maps Claude swarm aliases to Claude-native models', () => {
    const route = resolveModelForExecutor(task('swarm-heavy'), 'claude-code', 'complex', entry('claude-code'));
    expect(route?.model).toBe('claude-sonnet-4-6');
  });

  test('explicit Opus model name passes through on claude-code (ZOU-397 override path)', () => {
    const route = resolveModelForExecutor(task('claude-opus-4-7'), 'claude-code', 'complex', entry('claude-code'));
    expect(route?.model).toBe('claude-opus-4-7');
  });

  test('strips Claude provider prefix', () => {
    const route = resolveModelForExecutor(task('cc/claude-sonnet-4-6'), 'claude-code', 'moderate', entry('claude-code'));
    expect(route?.model).toBe('claude-sonnet-4-6');
  });

  test('maps Gemini tiers to Gemini-native models', () => {
    const route = resolveModelForExecutor(task('swarm-mid'), 'gemini', 'moderate', entry('gemini'));
    expect(route?.model).toBe('gemini-2.5-pro');
  });

  test('keeps Gemini-native model names and strips gc prefix', () => {
    const route = resolveModelForExecutor(task('gc/gemini-2.5-flash'), 'gemini', 'simple', entry('gemini'));
    expect(route?.model).toBe('gemini-2.5-flash');
  });

  test('falls back when executor receives an incompatible model family', () => {
    const route = resolveModelForExecutor(task('claude-opus-4-6'), 'gemini', 'complex', entry('gemini'));
    expect(route?.model).toBe('gemini-2.5-flash');
  });

  test('preserves provider-qualified OpenCode models', () => {
    const route = resolveModelForExecutor(
      task('xai/grok-4.3'),
      'opencode',
      'moderate',
      entry('opencode'),
    );
    expect(route?.model).toBe('xai/grok-4.3');
  });

  test('uses the verified OpenCode cross-provider tier ladder', () => {
    expect(resolveModelForExecutor(task(), 'opencode', 'simple', entry('opencode'))?.model).toBe(
      'synthetic-new/hf:zai-org/GLM-5.2',
    );
    expect(resolveModelForExecutor(task(), 'opencode', 'complex', entry('opencode'))?.model).toBe(
      'xai/grok-build-0.1',
    );
  });

  test('rejects opaque BYOK identifiers for OpenCode', () => {
    const route = resolveModelForExecutor(
      task('byok:opaque-id'),
      'opencode',
      'moderate',
      entry('opencode'),
    );
    expect(route).toBeNull();
  });
});
