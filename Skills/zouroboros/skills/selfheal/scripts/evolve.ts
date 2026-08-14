#!/usr/bin/env bun
/**
 * Runtime entrypoint for Zouroboros evolve (dual-home delegation).
 *
 * Delegates to the monorepo standalone/evolve.ts — NOT the library evolve() — because the
 * standalone path carries the anti-Goodhart machinery (held-out divergence tripwire,
 * goodhartFlag → success=false, drift escalation; seed-antigoodhart-wiring E1). Shipping a
 * stale mirror would silently drop that gate. All args pass straight through.
 *
 * WORKSPACE resolves from ZO_WORKSPACE, else derived from this script's location.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.ZO_WORKSPACE || join(import.meta.dir, '../../../../..');
const TARGET = join(WORKSPACE, 'packages/selfheal/src/standalone/evolve.ts');

if (!existsSync(TARGET)) {
  console.error(
    `[evolve] monorepo source not found at ${TARGET}\n` +
      `Set ZO_WORKSPACE to the repo root containing packages/selfheal.`
  );
  process.exit(1);
}

const child = spawnSync('bun', [TARGET, ...Bun.argv.slice(2)], {
  cwd: WORKSPACE,
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
