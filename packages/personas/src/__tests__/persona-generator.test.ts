import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { generatePersona } from '../generators/persona';
import type { PersonaConfig } from '../types';

const TEST_DIR = join(import.meta.dir, '../../.test-generator');

const config: PersonaConfig = {
  name: 'Jessica',
  slug: 'jessica',
  domain: 'general',
  description: 'Jessica persona for general domain',
  expertise: [],
  requiresApiKey: false,
  safetyRules: [],
  capabilities: [],
};

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('generatePersona', () => {
  test('writes persona files under outputDir/<slug>', async () => {
    await generatePersona(config, { outputDir: TEST_DIR });
    const dir = join(TEST_DIR, 'jessica');
    expect(existsSync(join(dir, 'IDENTITY', 'jessica.md'))).toBe(true);
    expect(existsSync(join(dir, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(dir, 'SAFETY.md'))).toBe(true);
    expect(existsSync(join(dir, 'PROMPT.md'))).toBe(true);
  });

  test('skill scaffold lands under outputDir/Skills, not the parent (GitHub #382)', async () => {
    const result = await generatePersona(config, { outputDir: TEST_DIR });
    const skillPhase = result.find((r) => r.phase === 6);
    expect(skillPhase?.output).toBe(join(TEST_DIR, 'Skills', 'jessica-skill'));
    expect(existsSync(join(TEST_DIR, 'Skills', 'jessica-skill', 'SKILL.md'))).toBe(true);
    // Must NOT leak one directory above the output base.
    expect(existsSync(join(TEST_DIR, '..', 'Skills', 'jessica-skill'))).toBe(false);
  });

  test('skipSkill omits the scaffold', async () => {
    const result = await generatePersona(config, { outputDir: TEST_DIR, skipSkill: true });
    expect(result.find((r) => r.phase === 6)?.status).toBe('skipped');
    expect(existsSync(join(TEST_DIR, 'Skills', 'jessica-skill'))).toBe(false);
  });
});
