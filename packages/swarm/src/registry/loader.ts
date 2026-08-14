/**
 * Executor registry loader
 * 
 * Loads executor configurations from JSON registry files.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { ExecutorRegistryEntry } from '../types.js';

const WORKSPACE_ROOT_OVERRIDE = process.env.ZOUROBOROS_WORKSPACE_ROOT;
const DEFAULT_REGISTRY_PATHS = [
  ...(WORKSPACE_ROOT_OVERRIDE
    ? []
    : [join(dirname(fileURLToPath(import.meta.url)), '..', 'executor', 'registry', 'executor-registry.json')]),
  'Skills/zo-swarm-executors/registry/executor-registry.json',
  '.zouroboros/executors.json',
];

const WORKSPACE_ROOT = WORKSPACE_ROOT_OVERRIDE || getWorkspaceRoot();

export interface Registry {
  executors: ExecutorRegistryEntry[];
  description?: string;
}

export function loadRegistry(customPath?: string): Registry {
  const paths = customPath ? [customPath] : DEFAULT_REGISTRY_PATHS;

  for (const path of paths) {
    const fullPath = isAbsolute(path) ? path : join(WORKSPACE_ROOT, path);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content) as Registry & {
          executors: Array<ExecutorRegistryEntry & { best_for?: string[] }>;
        };
        return {
          ...parsed,
          executors: parsed.executors.map(entry => {
            const legacyEntry = entry as ExecutorRegistryEntry & { best_for?: string[] };
            return {
              ...legacyEntry,
              bestFor: legacyEntry.bestFor ?? legacyEntry.best_for ?? [],
            };
          }),
        };
      } catch (err) {
        console.warn(`Failed to load registry from ${fullPath}:`, err);
      }
    }
  }
  
  // Return empty registry if none found
  return { executors: [], description: 'Empty default registry' };
}

export function findExecutor(registry: Registry, executorId: string): ExecutorRegistryEntry | undefined {
  return registry.executors.find(e => e.id === executorId);
}

export function listExecutors(registry: Registry): ExecutorRegistryEntry[] {
  return registry.executors;
}

export function getLocalExecutors(registry: Registry): ExecutorRegistryEntry[] {
  return registry.executors.filter(e => e.executor === 'local');
}

export function isExecutorAutoRoutingEnabled(
  entry: ExecutorRegistryEntry,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const gate = entry.rollout?.autoRoutingEnv;
  return !gate || env[gate] === '1';
}

export function getAutoRoutableExecutors(registry: Registry): ExecutorRegistryEntry[] {
  return getLocalExecutors(registry).filter(entry => isExecutorAutoRoutingEnabled(entry));
}
