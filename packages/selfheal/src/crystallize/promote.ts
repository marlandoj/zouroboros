/**
 * promote.ts — move an approved candidate from Skills/_candidates/<slug>/
 * to Skills/<slug>/.
 *
 * Pre-conditions (caller must have already checked):
 *   • DB row exists with approval_status='approved' (or transitioning).
 *   • candidate_path is canonical and inside Skills/_candidates/.
 *   • destination Skills/<slug>/ does not already exist (slug-collision is
 *     handled at draft time via auto-suffix).
 *
 * Post-conditions on success:
 *   • Source directory removed.
 *   • Destination directory exists with identical file tree.
 *   • Returns the absolute destination path so the caller can update DB
 *     `promoted_path` and append the 'promoted' event.
 *
 * Failure modes (each raises a typed error so the CLI can surface them):
 *   • CandidateMissingError       — _candidates/<slug>/ not found
 *   • DestinationExistsError      — Skills/<slug>/ already populated
 *   • PromotionUnsafePathError    — slug escapes Skills/_candidates/ (..)
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

const CANDIDATES_DIR_NAME = '_candidates';

export class CandidateMissingError extends Error {
  constructor(path: string) {
    super(`candidate not found at ${path}`);
    this.name = 'CandidateMissingError';
  }
}

export class DestinationExistsError extends Error {
  constructor(path: string) {
    super(`destination already exists at ${path}`);
    this.name = 'DestinationExistsError';
  }
}

export class PromotionUnsafePathError extends Error {
  constructor(reason: string) {
    super(`unsafe promotion path: ${reason}`);
    this.name = 'PromotionUnsafePathError';
  }
}

export interface PromoteInputs {
  /** Absolute path to Skills/_candidates/<slug>/. */
  candidate_path: string;
  /** Absolute path to Skills/ (parent of both _candidates and the target). */
  skills_root: string;
  /** Slug — must match the directory name under _candidates and the target. */
  slug: string;
}

export interface PromoteResult {
  /** Absolute path to the new Skills/<slug>/ directory. */
  promoted_path: string;
}

function assertSafePath(p: string, label: string): void {
  if (!isAbsolute(p)) {
    throw new PromotionUnsafePathError(`${label} not absolute: ${p}`);
  }
  if (p.includes('..')) {
    throw new PromotionUnsafePathError(`${label} contains traversal: ${p}`);
  }
}

export function promote(inputs: PromoteInputs): PromoteResult {
  assertSafePath(inputs.candidate_path, 'candidate_path');
  assertSafePath(inputs.skills_root, 'skills_root');

  // Slug sanity — re-validated even though the caller already did, to keep
  // promote() safe to call directly (e.g. from a manual recovery script).
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(inputs.slug)) {
    throw new PromotionUnsafePathError(`slug regex mismatch: ${inputs.slug}`);
  }

  const expectedCandidate = normalize(
    join(inputs.skills_root, CANDIDATES_DIR_NAME, inputs.slug),
  );
  const observedCandidate = resolve(inputs.candidate_path);
  if (observedCandidate !== expectedCandidate) {
    throw new PromotionUnsafePathError(
      `candidate_path drift — expected ${expectedCandidate}, got ${observedCandidate}`,
    );
  }

  const destination = normalize(join(inputs.skills_root, inputs.slug));

  if (!existsSync(observedCandidate)) {
    throw new CandidateMissingError(observedCandidate);
  }
  if (existsSync(destination)) {
    throw new DestinationExistsError(destination);
  }

  // Ensure the parent of the destination exists (the Skills/ root itself).
  const parent = dirname(destination);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  renameSync(observedCandidate, destination);

  return { promoted_path: destination };
}

/**
 * Archive an expired or rejected candidate to Skills/_candidates/_expired/<slug>-<id>/
 * so the artifact remains auditable but is removed from the active queue.
 *
 * Returns the archive path. Idempotent — if archive already exists, the
 * source dir is removed without overwriting.
 */
export function archiveCandidate(opts: {
  candidate_path: string;
  skills_root: string;
  slug: string;
  id: string;
}): { archive_path: string } {
  assertSafePath(opts.candidate_path, 'candidate_path');
  assertSafePath(opts.skills_root, 'skills_root');

  const archiveRoot = join(opts.skills_root, CANDIDATES_DIR_NAME, '_expired');
  if (!existsSync(archiveRoot)) {
    mkdirSync(archiveRoot, { recursive: true });
  }
  const archiveName = `${opts.slug}-${opts.id.slice(0, 8)}`;
  const archivePath = join(archiveRoot, archiveName);

  if (!existsSync(opts.candidate_path)) {
    return { archive_path: archivePath };
  }
  if (existsSync(archivePath)) {
    rmSync(opts.candidate_path, { recursive: true, force: true });
    return { archive_path: archivePath };
  }
  renameSync(opts.candidate_path, archivePath);
  return { archive_path: archivePath };
}
