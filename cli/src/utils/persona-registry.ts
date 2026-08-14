/**
 * Persona registry
 *
 * `zouroboros persona create` writes personas to disk but produced no state
 * that `zouroboros persona list` could enumerate (GitHub #382). This module is
 * the shared source of truth: `create` records each generated persona here and
 * `list` reads it back, validating that the on-disk files still exist.
 *
 * Registry lives at ~/.zouroboros/personas.json, matching the convention used
 * by agents-registered.json and config.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface PersonaRecord {
  name: string;
  slug: string;
  domain: string;
  /** Absolute path to the persona directory (contains IDENTITY/<slug>.md). */
  dir: string;
  /** Absolute path to the generated skill scaffold, if one was created. */
  skillDir?: string;
  createdAt: string;
}

export function defaultRegistryPath(): string {
  return join(homedir(), '.zouroboros', 'personas.json');
}

function readRegistry(registryPath: string): PersonaRecord[] {
  if (!existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8'));
    return Array.isArray(parsed?.personas) ? parsed.personas : [];
  } catch {
    // Corrupt registry should not crash create/list — treat as empty.
    return [];
  }
}

function writeRegistry(registryPath: string, personas: PersonaRecord[]): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), personas }, null, 2)
  );
}

/** True when the persona's identity file still exists on disk. */
export function personaExistsOnDisk(record: PersonaRecord): boolean {
  return existsSync(join(record.dir, 'IDENTITY', `${record.slug}.md`));
}

/** Upsert a persona record (keyed by slug). */
export function registerPersona(
  record: PersonaRecord,
  registryPath: string = defaultRegistryPath()
): void {
  const personas = readRegistry(registryPath).filter((p) => p.slug !== record.slug);
  personas.push(record);
  personas.sort((a, b) => a.slug.localeCompare(b.slug));
  writeRegistry(registryPath, personas);
}

/**
 * Return registered personas whose files still exist on disk. Records whose
 * directories were removed are pruned from the registry so `list` never shows
 * stale entries.
 */
export function listPersonas(
  registryPath: string = defaultRegistryPath()
): PersonaRecord[] {
  const personas = readRegistry(registryPath);
  const live = personas.filter(personaExistsOnDisk);
  if (live.length !== personas.length) writeRegistry(registryPath, live);
  return live;
}
