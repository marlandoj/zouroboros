/**
 * Runtime capability adapters: {@link Notifier}, {@link Scheduler}, and
 * {@link AgentRegistry}, each with a Zo binding and a bare-box no-op fallback.
 *
 * @module zouroboros-core/adapters
 */

export * from './types.js';
export {
  createZoAdapters,
  parseAgentList,
  ZoNotifier,
  ZoScheduler,
  ZoAgentRegistry,
} from './zo.js';
export type { ZoAdapterConfig } from './zo.js';
export {
  createNoopAdapters,
  NoopNotifier,
  NoopScheduler,
  NoopAgentRegistry,
} from './noop.js';
export type { NoopAdapterConfig } from './noop.js';
export {
  SKILL_GUARD_BEGIN,
  SKILL_GUARD_END,
  BARE_BOX_GUARD_SOURCE,
  renderSkillGuardBlock,
  extractSkillGuardBlock,
  bareBoxZoAvailable,
} from './skill-guard.js';

import type { Adapters, AdapterMode } from './types.js';
import { createZoAdapters } from './zo.js';
import { createNoopAdapters } from './noop.js';

export interface CreateAdaptersOptions {
  /** Environment to read; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Sink for fallback/log output; defaults to console.error. */
  logger?: (line: string) => void;
  /** Injected for testing the Zo path; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Decide which adapter set to use. The Zo binding is selected only when a Zo
 * client-identity token is present; otherwise the bare-box no-op fallback is
 * used. `ZOUROBOROS_ADAPTER=zo|noop` forces the choice (a forced `zo` still
 * needs a token, else it falls back).
 */
export function resolveAdapterMode(
  env: Record<string, string | undefined> = process.env,
): AdapterMode {
  const forced = env.ZOUROBOROS_ADAPTER?.toLowerCase();
  if (forced === 'noop') return 'noop';
  const token = env.ZO_CLIENT_IDENTITY_TOKEN || env.ZO_TOKEN;
  if (forced === 'zo') return token ? 'zo' : 'noop';
  return token ? 'zo' : 'noop';
}

/**
 * Build the adapter set for the current environment. Never throws on a bare box:
 * absent Zo credentials yield the no-op fallback.
 */
export function createAdapters(options: CreateAdaptersOptions = {}): Adapters {
  const env = options.env ?? process.env;
  const mode = resolveAdapterMode(env);

  if (mode === 'zo') {
    const token = (env.ZO_CLIENT_IDENTITY_TOKEN || env.ZO_TOKEN)!;
    const zo = createZoAdapters({ token, fetchImpl: options.fetchImpl, logger: options.logger });
    return { mode, ...zo };
  }

  const noop = createNoopAdapters({ logger: options.logger });
  return { mode, ...noop };
}
