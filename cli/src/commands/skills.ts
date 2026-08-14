import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getWorkspaceRoot } from 'zouroboros-core';
import { installBundledSkills } from '../utils/skills-laydown.js';

/**
 * Resolve the default skills install destination.
 *
 * Priority:
 *   1. `ZOUROBOROS_SKILLS_DIR` env var (explicit override)
 *   2. `<workspace>/Skills` when the resolved workspace contains a Skills dir
 *      (honors `ZOUROBOROS_WORKSPACE` / `ZO_WORKSPACE`, so the resolved
 *      workspace is used rather than a fixed host path)
 *   3. `~/Skills` (historical default for non-workspace installs)
 */
export function resolveDefaultSkillsDest(): string {
  if (process.env.ZOUROBOROS_SKILLS_DIR) {
    return process.env.ZOUROBOROS_SKILLS_DIR;
  }
  const workspace = getWorkspaceRoot();
  if (workspace && existsSync(join(workspace, 'Skills'))) {
    return join(workspace, 'Skills');
  }
  return join(homedir(), 'Skills');
}

export const skillsCommand = new Command('skills')
  .description('Manage Zouroboros skills')
  .addCommand(
    new Command('install')
      .description('Lay the bundled skills down into the workspace Skills/ dir (or custom directory)')
      .option('--dest <dir>', 'Target directory (default: <workspace>/Skills, fallback ~/Skills)')
      .option('--skill <name>', 'Install a single skill by name')
      .action((options) => {
        const dest = options.dest || resolveDefaultSkillsDest();
        const { installed, source } = installBundledSkills(dest, { only: options.skill });

        if (installed.length === 0) {
          if (options.skill) {
            console.log(chalk.yellow(`⚠️  Skill "${options.skill}" not found in bundle (${source})`));
          } else {
            console.log(chalk.yellow(`⚠️  No bundled skills found at ${source}`));
          }
          return;
        }

        console.log(chalk.cyan(`\n🐍⭕ Installing ${installed.length} skill(s) → ${dest}\n`));
        for (const name of installed) {
          console.log(chalk.green(`  ✅ ${name}`));
        }
        console.log('');
      })
  )
  .addCommand(
    new Command('list')
      .description('List available skills')
      .action(() => {
        console.log(`
Zouroboros Skills (bundled MVP set)
═══════════════════════════════════

Evaluation & Consensus:
  consensus-gate          Multi-model consensus review with escalation valve
  three-stage-eval        Mechanical/semantic/consensus evaluation pipeline

Self-Enhancement:
  zouroboros-introspect   7-metric health scorecard for the Zo ecosystem
  zouroboros-prescribe    Auto-generate improvement prescriptions from a scorecard
  zouroboros-evolve       Execute prescriptions with regression detection

Reliability:
  agent-model-healer      Detect unhealthy agent models and fail over fallback chains
  build-watchdog          Monitor active builds and alert on regressions

Spec & Interview:
  spec-first-interview    Socratic interview & seed specification generator

Install:
  zouroboros skills install                         # Lay all bundled skills into <workspace>/Skills
  zouroboros skills install --skill consensus-gate  # Install one skill
  zouroboros skills install --dest ./my-skills      # Custom directory
`);
      })
  );
