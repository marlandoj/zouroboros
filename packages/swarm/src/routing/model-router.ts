import type { ComplexityTier, ExecutorRegistryEntry, Task } from '../types.js';

export interface ModelRoute {
  executorId: string;
  model: string;
  tier: ComplexityTier;
  source: 'task' | 'role' | 'registry' | 'default';
}

interface RouterSpec {
  defaultModel: string;
  tierMap: Record<ComplexityTier | string, string>;
  acceptedPrefixes?: string[];
  rejectPrefixes?: string[];
  stripPrefixes?: string[];
  fallbackModel?: string;
  passthrough?: boolean;
}

const DEFAULT_ROUTERS: Record<string, RouterSpec> = {
  'claude-code': {
    defaultModel: 'claude-sonnet-4-6',
    fallbackModel: 'claude-haiku-4-5-20251001',
    acceptedPrefixes: ['claude'],
    stripPrefixes: ['cc/'],
    // ZOU-397 (June-15 Agent SDK credit cutover): Opus removed from tier maps.
    // Background/swarm work caps at Sonnet; Opus only via explicit model name.
    tierMap: {
      trivial: 'claude-haiku-4-5-20251001',
      simple: 'claude-haiku-4-5-20251001',
      moderate: 'claude-sonnet-4-6',
      complex: 'claude-sonnet-4-6',
      light: 'claude-haiku-4-5-20251001',
      mid: 'claude-sonnet-4-6',
      heavy: 'claude-sonnet-4-6',
      failover: 'claude-haiku-4-5-20251001',
      'swarm-light': 'claude-haiku-4-5-20251001',
      'swarm-mid': 'claude-sonnet-4-6',
      'swarm-heavy': 'claude-sonnet-4-6',
      'swarm-failover': 'claude-haiku-4-5-20251001',
    },
  },
  gemini: {
    defaultModel: 'gemini-2.5-flash',
    fallbackModel: 'gemini-2.5-flash',
    acceptedPrefixes: ['gemini', 'models/'],
    stripPrefixes: ['gc/'],
    tierMap: {
      trivial: 'gemini-2.5-flash',
      simple: 'gemini-2.5-flash',
      moderate: 'gemini-2.5-pro',
      complex: 'gemini-2.5-pro',
      light: 'gemini-2.5-flash',
      mid: 'gemini-2.5-pro',
      heavy: 'gemini-2.5-pro',
      failover: 'gemini-2.5-flash',
      'swarm-light': 'gemini-2.5-flash',
      'swarm-mid': 'gemini-2.5-pro',
      'swarm-heavy': 'gemini-2.5-pro',
      'swarm-failover': 'gemini-2.5-flash',
    },
  },
  codex: {
    defaultModel: 'gpt-5.3-codex',
    fallbackModel: 'gpt-5.1-codex-mini',
    acceptedPrefixes: ['gpt-', 'o'],
    tierMap: {
      trivial: 'gpt-5.1-codex-mini',
      simple: 'gpt-5.1-codex-mini',
      moderate: 'gpt-5.3-codex',
      complex: 'gpt-5.4',
      light: 'gpt-5.1-codex-mini',
      mid: 'gpt-5.3-codex',
      heavy: 'gpt-5.4',
      failover: 'gpt-5.1-codex-mini',
      'swarm-light': 'gpt-5.1-codex-mini',
      'swarm-mid': 'gpt-5.3-codex',
      'swarm-heavy': 'gpt-5.4',
      'swarm-failover': 'gpt-5.1-codex-mini',
    },
  },
  hermes: {
    defaultModel: 'swarm-failover',
    passthrough: true,
    tierMap: {
      trivial: 'light',
      simple: 'light',
      moderate: 'mid',
      complex: 'heavy',
      light: 'light',
      mid: 'mid',
      heavy: 'heavy',
      failover: 'swarm-failover',
      'swarm-light': 'light',
      'swarm-mid': 'mid',
      'swarm-heavy': 'heavy',
      'swarm-failover': 'swarm-failover',
    },
  },
  opencode: {
    defaultModel: 'synthetic-new/hf:zai-org/GLM-5.2',
    fallbackModel: 'xai/grok-build-0.1',
    passthrough: true,
    rejectPrefixes: ['byok:'],
    tierMap: {
      trivial: 'openrouter/openai/gpt-oss-20b:free',
      simple: 'synthetic-new/hf:zai-org/GLM-5.2',
      moderate: 'synthetic-new/hf:zai-org/GLM-5.2',
      complex: 'xai/grok-build-0.1',
      light: 'openrouter/openai/gpt-oss-20b:free',
      mid: 'synthetic-new/hf:zai-org/GLM-5.2',
      heavy: 'xai/grok-build-0.1',
      failover: 'xai/grok-build-0.1',
      'swarm-light': 'openrouter/openai/gpt-oss-20b:free',
      'swarm-mid': 'synthetic-new/hf:zai-org/GLM-5.2',
      'swarm-heavy': 'xai/grok-build-0.1',
      'swarm-failover': 'xai/grok-build-0.1',
    },
  },
};

function normalizeSpec(entry?: ExecutorRegistryEntry): RouterSpec | undefined {
  const fromRegistry = entry?.modelRouter;
  const fallback = DEFAULT_ROUTERS[entry?.id ?? ''];
  if (!fromRegistry) return fallback;

  return {
    defaultModel: fromRegistry.defaultModel ?? fallback?.defaultModel ?? entry?.config.model ?? '',
    fallbackModel: fromRegistry.fallbackModel ?? fallback?.fallbackModel,
    acceptedPrefixes: fromRegistry.acceptedPrefixes ?? fallback?.acceptedPrefixes,
    rejectPrefixes: fromRegistry.rejectPrefixes ?? fallback?.rejectPrefixes,
    stripPrefixes: fromRegistry.stripPrefixes ?? fallback?.stripPrefixes,
    passthrough: fromRegistry.passthrough ?? fallback?.passthrough,
    tierMap: {
      ...(fallback?.tierMap ?? {}),
      ...(fromRegistry.tierMap ?? {}),
    },
  };
}

function stripKnownPrefix(model: string, spec: RouterSpec): string {
  for (const prefix of spec.stripPrefixes ?? []) {
    if (model.startsWith(prefix)) return model.slice(prefix.length);
  }
  return model;
}

function acceptsModel(model: string, spec: RouterSpec): boolean {
  if (spec.passthrough) return true;
  return (spec.acceptedPrefixes ?? []).some(prefix => model.startsWith(prefix));
}

export function resolveModelForExecutor(
  task: Task,
  executorId: string,
  tier: ComplexityTier,
  entry?: ExecutorRegistryEntry,
  roleModel?: string,
): ModelRoute | null {
  const spec = normalizeSpec(entry ?? ({ id: executorId } as ExecutorRegistryEntry));
  if (!spec) return null;

  const requestedModel = task.model || roleModel;
  let model = requestedModel
    ? (spec.tierMap[requestedModel] ?? requestedModel)
    : (spec.tierMap[tier] ?? spec.defaultModel);
  model = stripKnownPrefix(model, spec);

  if ((spec.rejectPrefixes ?? []).some(prefix => model.startsWith(prefix))) {
    return null;
  }

  if (!acceptsModel(model, spec)) {
    model = spec.fallbackModel ?? spec.defaultModel;
  }

  if (!model) return null;

  return {
    executorId,
    model,
    tier,
    source: task.model ? 'task' : roleModel ? 'role' : entry?.modelRouter ? 'registry' : 'default',
  };
}
