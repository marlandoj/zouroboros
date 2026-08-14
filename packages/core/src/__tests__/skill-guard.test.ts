import { describe, expect, test } from 'bun:test';
import {
  bareBoxZoAvailable,
  renderSkillGuardBlock,
  extractSkillGuardBlock,
  BARE_BOX_GUARD_SOURCE,
  SKILL_GUARD_BEGIN,
  SKILL_GUARD_END,
} from '../adapters/skill-guard.js';
import { resolveAdapterMode } from '../adapters/index.js';

describe('skill-guard', () => {
  test('bareBoxZoAvailable agrees with resolveAdapterMode for every token combo', () => {
    const combos: Record<string, string | undefined>[] = [
      {},
      { ZO_CLIENT_IDENTITY_TOKEN: 't' },
      { ZO_TOKEN: 't' },
      { ZO_CLIENT_IDENTITY_TOKEN: 't', ZO_TOKEN: 't' },
    ];
    for (const env of combos) {
      expect(bareBoxZoAvailable(env)).toBe(resolveAdapterMode(env) === 'zo');
    }
  });

  test('rendered block round-trips through extract', () => {
    const block = renderSkillGuardBlock();
    const host = `line before\n\n${block}\n\nline after\n`;
    expect(extractSkillGuardBlock(host)).toBe(block);
  });

  test('extract returns null when markers are absent', () => {
    expect(extractSkillGuardBlock('function zoAvailable() { return true; }')).toBeNull();
  });

  test('extract returns null when only the begin marker is present', () => {
    expect(extractSkillGuardBlock(`${SKILL_GUARD_BEGIN}\nfunction x() {}`)).toBeNull();
  });

  test('rendered block is delimited and carries the canonical token predicate', () => {
    const block = renderSkillGuardBlock();
    expect(block.startsWith(SKILL_GUARD_BEGIN)).toBe(true);
    expect(block.endsWith(SKILL_GUARD_END)).toBe(true);
    expect(block).toContain(BARE_BOX_GUARD_SOURCE);
    expect(BARE_BOX_GUARD_SOURCE).toContain(
      'process.env.ZO_CLIENT_IDENTITY_TOKEN || process.env.ZO_TOKEN',
    );
  });
});
