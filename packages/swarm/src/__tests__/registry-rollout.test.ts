import { describe, expect, test } from 'bun:test';
import {
  getAutoRoutableExecutors,
  isExecutorAutoRoutingEnabled,
  type Registry,
} from '../registry/loader.js';
import type { ExecutorRegistryEntry } from '../types.js';

function entry(id: string, autoRoutingEnv?: string): ExecutorRegistryEntry {
  return {
    id,
    name: id,
    executor: 'local',
    description: id,
    expertise: [],
    bestFor: [],
    config: { defaultTimeout: 300 },
    ...(autoRoutingEnv ? { rollout: { autoRoutingEnv } } : {}),
  };
}

describe('executor rollout gates', () => {
  test('keeps ungated executors routable and gates OpenCode by environment', () => {
    const opencode = entry('opencode', 'SWARM_OPENCODE_ENABLED');
    expect(isExecutorAutoRoutingEnabled(opencode, {})).toBe(false);
    expect(isExecutorAutoRoutingEnabled(opencode, { SWARM_OPENCODE_ENABLED: '1' })).toBe(true);
  });

  test('filters only automatic routing, not registry reachability', () => {
    const registry: Registry = {
      executors: [entry('claude-code'), entry('opencode', 'SWARM_OPENCODE_ENABLED')],
    };
    expect(getAutoRoutableExecutors(registry).map(item => item.id)).toEqual(['claude-code']);
  });
});
