import { existsSync, mkdirSync, readdirSync, statSync, cpSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Absolute path to the skills bundle shipped inside the @zouroboros/cli
 * package. Resolves the same for compiled and source layouts:
 *   dist/utils/skills-laydown.js -> ../../skills  => <pkgroot>/skills
 *   src/utils/skills-laydown.ts  -> ../../skills  => cli/skills
 */
export function bundledSkillsDir(): string {
  const here = import.meta.dirname ?? __dirname;
  return resolve(here, '../../skills');
}

export interface SkillLaydownResult {
  installed: string[];
  skipped: string[];
  source: string;
}

/**
 * Copy each bundled skill directory into `dest/<skill-name>`, overwriting any
 * existing copy. This is the single source of truth for `zouroboros init` and
 * `zouroboros skills install` — both lay skills down from the packaged bundle
 * rather than from scattered monorepo package sources.
 *
 * @param dest       destination Skills dir (e.g. `<workspace>/Skills`)
 * @param opts.only  install a single skill by name
 * @param opts.sourceDir override the bundle source (used by tests)
 */
export function installBundledSkills(
  dest: string,
  opts: { only?: string; sourceDir?: string } = {},
): SkillLaydownResult {
  const source = opts.sourceDir ?? bundledSkillsDir();
  const result: SkillLaydownResult = { installed: [], skipped: [], source };

  if (!existsSync(source)) {
    return result;
  }

  mkdirSync(dest, { recursive: true });

  for (const name of readdirSync(source)) {
    const skillSrc = join(source, name);
    if (!statSync(skillSrc).isDirectory()) continue;
    if (opts.only && opts.only !== name) {
      result.skipped.push(name);
      continue;
    }
    cpSync(skillSrc, join(dest, name), { recursive: true });
    result.installed.push(name);
  }

  return result;
}
