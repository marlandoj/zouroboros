#!/usr/bin/env bun
/**
 * Stamp / verify the bare-box degrade guard in laid-down skills.
 *
 * The canonical guard lives in `packages/core/src/adapters/skill-guard.ts`. Laid-down
 * skills cannot import core at runtime (ZOU-466 self-containment), so the guard text is
 * copied into each skill between marker comments and kept in sync mechanically instead:
 *
 *   pnpm verify:skill-guards   (or: bun scripts/stamp-skill-guards.ts)            # CI check, exit 1 on drift
 *   pnpm stamp:skill-guards    (or: bun scripts/stamp-skill-guards.ts --write)    # regenerate from core
 *
 * ZOU-480.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderSkillGuardBlock,
  extractSkillGuardBlock,
  SKILL_GUARD_BEGIN,
} from '../packages/core/src/adapters/skill-guard.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Laid-down skill files that carry the bare-box guard, single-sourced from core. */
const TARGETS = ['cli/skills/agent-model-healer/scripts/healer.ts'];

const write = process.argv.includes('--write');
const canonical = renderSkillGuardBlock();
let drift = 0;

for (const rel of TARGETS) {
  const abs = join(REPO_ROOT, rel);
  const text = readFileSync(abs, 'utf8');
  const current = extractSkillGuardBlock(text);

  if (current === null) {
    console.error(`✗ ${rel}: no guard region found (expected marker "${SKILL_GUARD_BEGIN}")`);
    drift++;
    continue;
  }
  if (current === canonical) {
    console.log(`✓ ${rel}`);
    continue;
  }
  if (write) {
    writeFileSync(abs, text.replace(current, canonical));
    console.log(`↻ ${rel} — re-stamped from core`);
  } else {
    console.error(`✗ ${rel}: guard drifted from zouroboros-core/adapters — run \`pnpm stamp:skill-guards\``);
    drift++;
  }
}

if (!write && drift > 0) {
  console.error(`\n${drift} laid-down skill guard(s) out of sync with core.`);
  process.exit(1);
}
console.log(write ? 'Skill guards stamped from core.' : 'All laid-down skill guards single-sourced from core.');
