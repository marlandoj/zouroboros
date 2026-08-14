/**
 * Single source of truth for the bare-box degrade guard that laid-down skills
 * carry. Skills under `cli/skills/**` must run standalone with no `node_modules`
 * (the ZOU-466 self-containment invariant), so they cannot `import` this module
 * at runtime. Instead the canonical guard text below is *stamped* into each skill
 * between {@link SKILL_GUARD_BEGIN}/{@link SKILL_GUARD_END} markers by
 * `scripts/stamp-skill-guards.ts`, and CI (`pnpm verify:skill-guards`) fails if a
 * stamped copy drifts from this source. That gives one owner for the guard
 * without a runtime dependency on core.
 *
 * The guard mirrors {@link resolveAdapterMode} for the token-presence case
 * (`ZO_CLIENT_IDENTITY_TOKEN || ZO_TOKEN`). It deliberately does *not* honor the
 * `ZOUROBOROS_ADAPTER` override — laid-down skills degrade on raw token absence
 * only, matching their pre-existing hand-written behavior.
 *
 * @module zouroboros-core/adapters
 */

/** Opening delimiter of a stamped guard region in a laid-down skill. */
export const SKILL_GUARD_BEGIN =
  '// >>> BEGIN zouroboros-core bare-box guard (generated — DO NOT EDIT) >>>';

/** Closing delimiter of a stamped guard region in a laid-down skill. */
export const SKILL_GUARD_END =
  '// <<< END zouroboros-core bare-box guard <<<';

/**
 * Canonical bare-box guard body stamped into laid-down skills. Defined line-by-line
 * so the embedded backticks/`${}` stay literal. The host skill must provide a
 * `log(msg: string)` sink; `zoAvailable`/`bareBoxNotice` are otherwise self-contained.
 */
const GUARD_BODY_LINES = [
  '// Single-sourced from packages/core/src/adapters/skill-guard.ts.',
  '// Regenerate with `pnpm stamp:skill-guards`; CI (`pnpm verify:skill-guards`) fails on drift.',
  '// Mirrors zouroboros-core/adapters resolveAdapterMode() token check (NoopAgentRegistry/',
  '// NoopNotifier degrade). Host skill must provide a `log(msg: string)` sink.',
  'function zoAvailable(): boolean {',
  '  return !!(process.env.ZO_CLIENT_IDENTITY_TOKEN || process.env.ZO_TOKEN);',
  '}',
  '',
  'function bareBoxNotice(command: string): void {',
  '  const message =',
  '    "Zo binding unavailable (no ZO_CLIENT_IDENTITY_TOKEN/ZO_TOKEN). Agent healing " +',
  '    "and model probes are Zo-only capabilities; nothing to do on a bare box.";',
  '  log(`[notify] ${message}`);',
  '  console.log(JSON.stringify({ command, mode: "noop", zo: false, message }, null, 2));',
  '}',
];

/** Canonical guard body (without the marker delimiters). */
export const BARE_BOX_GUARD_SOURCE = GUARD_BODY_LINES.join('\n');

/** The full stamped region, delimiters included, as it should appear in a skill. */
export function renderSkillGuardBlock(): string {
  return [SKILL_GUARD_BEGIN, BARE_BOX_GUARD_SOURCE, SKILL_GUARD_END].join('\n');
}

/**
 * Extract the stamped guard region (delimiters included) from a skill file's text,
 * or `null` if the markers are absent.
 */
export function extractSkillGuardBlock(fileText: string): string | null {
  const begin = fileText.indexOf(SKILL_GUARD_BEGIN);
  if (begin === -1) return null;
  const end = fileText.indexOf(SKILL_GUARD_END, begin);
  if (end === -1) return null;
  return fileText.slice(begin, end + SKILL_GUARD_END.length);
}

/**
 * Canonical runtime predicate the stamped `zoAvailable()` mirrors: a Zo binding is
 * present when a client-identity token is set. Kept here so a core unit test can
 * pin the stamped logic to {@link resolveAdapterMode} without evaluating source text.
 */
export function bareBoxZoAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !!(env.ZO_CLIENT_IDENTITY_TOKEN || env.ZO_TOKEN);
}
