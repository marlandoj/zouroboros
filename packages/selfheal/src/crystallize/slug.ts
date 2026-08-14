/**
 * Skill-slug generator and validator.
 *
 * Per seed AC: slug regex ^[a-z][a-z0-9]*(-[a-z0-9]+)*$, length 3–48,
 * collision auto-suffix `-2`/`-3`. Path-traversal sequences are rejected by
 * the regex (no slashes, no dots).
 */

import { existsSync } from 'fs';
import { join } from 'path';

export const SLUG_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 48;

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: 'regex' | 'too_short' | 'too_long' };

export function validateSlug(slug: string): SlugValidation {
  if (slug.length < SLUG_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (slug.length > SLUG_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (!SLUG_REGEX.test(slug)) return { ok: false, reason: 'regex' };
  return { ok: true, slug };
}

/**
 * Normalize a candidate name into a slug-safe form. Does NOT enforce length;
 * the caller must validate.
 *
 * - lowercase
 * - replace any run of non [a-z0-9]+ with a single hyphen
 * - strip leading/trailing hyphens
 * - collapse repeated hyphens
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeSourceSlug(input: string): string {
  const normalized = slugify(input)
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return normalized.length >= SLUG_MIN_LENGTH ? normalized : 'crystallized';
}

export interface CollisionResolveOptions {
  /** Roots to check; first existing path wins. */
  candidatesRoot: string;
  promotedRoot: string;
  /** Maximum suffix to attempt; throws beyond. */
  maxSuffix?: number;
}

/**
 * If `<candidatesRoot>/<slug>` or `<promotedRoot>/<slug>` already exists,
 * returns `<slug>-2`, `<slug>-3`, ... up to maxSuffix. Resulting slug is
 * re-validated (length may exceed bound after suffix; caller should regen
 * from a shorter base if so).
 */
export function resolveSlugCollision(
  slug: string,
  opts: CollisionResolveOptions,
): string {
  const max = opts.maxSuffix ?? 99;
  const base = slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
  const taken = (s: string) =>
    existsSync(join(opts.candidatesRoot, s)) ||
    existsSync(join(opts.promotedRoot, s));

  if (!taken(base)) return base;
  for (let i = 2; i <= max; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(
    `slug collision exhausted suffix range 2..${max} for base ${base}`,
  );
}
