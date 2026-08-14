#!/usr/bin/env bun
/**
 * Runtime entrypoint for Zouroboros introspection (dual-home delegation).
 *
 * Source of truth is the monorepo packages/selfheal/src. This deployed skill copy was
 * never built (no sibling index.js), so rather than ship a stale mirror this wrapper
 * delegates to the monorepo CLI — guaranteeing the daily agent always runs the CURRENT
 * collectors, including Eval-Integrity + Wiring Health (seed-antigoodhart-wiring,
 * AC-S.1). All args (incl. --json / --help) pass straight through.
 *
 * WORKSPACE resolves from ZO_WORKSPACE, else is derived from this script's location
 * (<WORKSPACE>/Skills/zouroboros/skills/selfheal/scripts/), so it works regardless of cwd.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.ZO_WORKSPACE || join(import.meta.dir, '../../../../..');
const TARGET = join(WORKSPACE, 'packages/selfheal/src/cli/introspect.ts');

if (!existsSync(TARGET)) {
  console.error(
    `[introspect] monorepo source not found at ${TARGET}\n` +
      `Set ZO_WORKSPACE to the repo root containing packages/selfheal.`
  );
  process.exit(1);
}

const child = spawnSync('bun', [TARGET, ...Bun.argv.slice(2)], {
  cwd: WORKSPACE,
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
