/**
 * Hermetic env builder for the held-out grader shell-out (P0-3).
 *
 * The held-out examiner is the one process the optimizer must NOT be able to
 * bribe. `runProbe()` historically shelled out with no `env` key, so the child
 * inherited the full parent environment — every secret, every proxy override.
 * That is the reward-hacking surface: a candidate could read ANTHROPIC_* or
 * phone home to fudge its own grade.
 *
 * This builds an allowlist-only env (not a denylist): nothing is forwarded
 * unless it is on the curated trusted list. The grader's retrieval is purely
 * local + deterministic (a /tmp SQLite bank + FTS token overlap), so it needs
 * no secrets, no network, and no embeddings — only enough to (a) run `bun` and
 * (b) resolve its fixture paths.
 *
 * Unlike `buildSandboxEnv` in crystallize/eval-replay.ts (which sets
 * HOME=workspace), the grader needs the REAL HOME so `homedir()` resolves
 * `~/.zouroboros/holdout-fixtures.local.json`. So HOME is preserved verbatim.
 */

import { isSecretEnvName } from '../crystallize/eval-replay.js';

/**
 * Trusted env names copied verbatim from the parent when present. These bypass
 * the secret check by design — ZO_WORKSPACE collides with the ZO_ secret prefix
 * but is a path the grader cannot run without.
 */
export const HOLDOUT_PRESERVE_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'ZO_WORKSPACE',
  'ZOUROBOROS_DATA_DIR',
  // Control flag the grader child itself reads — must cross the sandbox boundary
  // so an operator's HOLDOUT_SUBCHECKS=0 actually reaches the runner. Non-secret
  // (display-only toggle); forwarding it opens no cheat surface.
  'HOLDOUT_SUBCHECKS',
] as const;

export interface HoldoutSandboxOptions {
  /**
   * Extra parent-env names to forward (escape hatch for a future grader that
   * legitimately needs one more var). Still secret-checked: a name matching a
   * secret prefix/exact is refused even when explicitly requested.
   */
  preserve?: readonly string[];
}

/**
 * Construct the env block for the held-out grader child. Pure — tests assert
 * it directly without spawning.
 */
export function buildHoldoutSandboxEnv(
  parent: NodeJS.ProcessEnv = process.env,
  opts: HoldoutSandboxOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // 1. Curated trusted preserve-list — copied verbatim when present.
  for (const name of HOLDOUT_PRESERVE_NAMES) {
    const v = parent[name];
    if (v !== undefined) env[name] = v;
  }

  // 2. Fallbacks for vars the grader cannot start without.
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  if (!env.USER) env.USER = 'zouroboros';

  // 3. Caller escape hatch — still secret-checked so a stray secret can never
  //    be forwarded, even on explicit request.
  if (opts.preserve) {
    for (const name of opts.preserve) {
      if (isSecretEnvName(name)) continue;
      const v = parent[name];
      if (v !== undefined) env[name] = v;
    }
  }

  // 4. Egress-refusing proxy — set LAST so neither the parent nor opts.preserve
  //    can override it. Port 0 is unbindable ⇒ every proxy-honoring connect
  //    fails. BOTH cases + ALL_PROXY: because the env is an allowlist (parent
  //    not inherited), an unset lowercase var would otherwise mean "no proxy"
  //    to tools that read lowercase (curl, requests/urllib3, Go, undici) ⇒
  //    direct connect, bypassing the block. So pin every variant to the sink.
  const SINK = 'http://127.0.0.1:0';
  env.HTTPS_PROXY = SINK;
  env.HTTP_PROXY = SINK;
  env.ALL_PROXY = SINK;
  env.https_proxy = SINK;
  env.http_proxy = SINK;
  env.all_proxy = SINK;
  env.NO_PROXY = '';
  env.no_proxy = '';

  return env;
}
