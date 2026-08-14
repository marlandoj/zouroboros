#!/usr/bin/env bun
/**
 * Runtime entrypoint for Zouroboros prescribe (dual-home delegation).
 *
 * Delegates to the monorepo standalone/prescribe.ts (source of truth). The standalone path
 * carries the live-introspection fallback whose INTROSPECT scorecard path was reconciled
 * under seed-antigoodhart-wiring AC-S.2. All args pass straight through.
 *
 * WORKSPACE resolves from ZO_WORKSPACE, else derived from this script's location.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.ZO_WORKSPACE || join(import.meta.dir, '../../../../..');
const TARGET = join(WORKSPACE, 'packages/selfheal/src/standalone/prescribe.ts');

if (!existsSync(TARGET)) {
  console.error(
    `[prescribe] monorepo source not found at ${TARGET}\n` +
      `Set ZO_WORKSPACE to the repo root containing packages/selfheal.`
  );
  process.exit(1);
}

const child = spawnSync('bun', [TARGET, ...Bun.argv.slice(2)], {
  cwd: WORKSPACE,
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
