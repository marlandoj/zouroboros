import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  registerPersona,
  listPersonas,
  personaExistsOnDisk,
  type PersonaRecord,
} from '../persona-registry';

const TEST_DIR = join(import.meta.dir, '../../../.test-persona-registry');
const REGISTRY = join(TEST_DIR, 'personas.json');

function makePersonaDir(slug: string): string {
  const dir = join(TEST_DIR, slug);
  mkdirSync(join(dir, 'IDENTITY'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY', `${slug}.md`), `# ${slug}`);
  return dir;
}

function record(slug: string, dir: string): PersonaRecord {
  return { name: slug, slug, domain: 'general', dir, createdAt: new Date().toISOString() };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('persona-registry', () => {
  test('empty registry lists nothing', () => {
    expect(listPersonas(REGISTRY)).toEqual([]);
  });

  test('registered persona appears in list (the #382 regression)', () => {
    const dir = makePersonaDir('jessica');
    registerPersona(record('jessica', dir), REGISTRY);
    const listed = listPersonas(REGISTRY);
    expect(listed.map((p) => p.slug)).toEqual(['jessica']);
    expect(listed[0].dir).toBe(dir);
  });

  test('upsert by slug does not duplicate', () => {
    const dir = makePersonaDir('jessica');
    registerPersona(record('jessica', dir), REGISTRY);
    registerPersona(record('jessica', dir), REGISTRY);
    expect(listPersonas(REGISTRY).length).toBe(1);
  });

  test('list prunes personas whose files were removed', () => {
    const dir = makePersonaDir('ghost');
    registerPersona(record('ghost', dir), REGISTRY);
    rmSync(dir, { recursive: true, force: true });
    expect(listPersonas(REGISTRY)).toEqual([]);
    // Pruned from the registry, not just filtered.
    expect(personaExistsOnDisk(record('ghost', dir))).toBe(false);
  });

  test('corrupt registry is treated as empty, not fatal', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(REGISTRY, '{ not json');
    expect(listPersonas(REGISTRY)).toEqual([]);
  });

  test('entries are sorted by slug', () => {
    registerPersona(record('zed', makePersonaDir('zed')), REGISTRY);
    registerPersona(record('alice', makePersonaDir('alice')), REGISTRY);
    expect(listPersonas(REGISTRY).map((p) => p.slug)).toEqual(['alice', 'zed']);
  });
});
