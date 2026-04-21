import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { getWorkspaceRoot } from 'zouroboros-core';

const REPO_ROOT = resolve(import.meta.dirname || __dirname, '../../..');

/**
 * Resolve the default skills install destination.
 *
 * Priority:
 *   1. `ZOUROBOROS_SKILLS_DIR` env var (explicit override)
 *   2. `<workspace>/Skills` when the resolved workspace contains a Skills dir
 *      (honors `ZOUROBOROS_WORKSPACE` / `ZO_WORKSPACE`, so Zo Computer users
 *      land in `/home/workspace/Skills` rather than `/root/Skills`)
 *   3. `~/Skills` (historical default for non-workspace installs)
 */
function resolveDefaultSkillsDest(): string {
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
      .description('Export skills to the workspace Skills/ dir (or custom directory)')
      .option('--dest <dir>', 'Target directory (default: <workspace>/Skills, fallback ~/Skills)')
      .option('--skill <name>', 'Install a single skill by name')
      .action((options) => {
        const dest = options.dest || resolveDefaultSkillsDest();
        const args: string[] = ['--dest', dest];
        if (options.skill) args.push('--skill', options.skill);
        spawn('bash', [resolve(REPO_ROOT, 'scripts/export-skills.sh'), ...args], {
          stdio: 'inherit',
        });
      })
  )
  .addCommand(
    new Command('list')
      .description('List available skills')
      .action(() => {
        console.log(`
Zouroboros Skills
═════════════════

Workflow Skills (packages/workflow):
  spec-first-interview    Socratic interview & seed specification generator
  three-stage-eval        Mechanical/semantic/consensus evaluation pipeline
  autoloop                Single-metric optimization loop (inspired by autoresearch)
  unstuck-lateral         5 lateral-thinking personas for creative problem solving

Self-Enhancement Skills (packages/selfheal):
  zouroboros-introspect   7-metric health scorecard for Zo ecosystem
  zouroboros-prescribe    Auto-generate improvement prescriptions from scorecard
  zouroboros-evolve       Execute prescriptions with regression detection

Core System Skills:
  zouroboros-swarm        Multi-agent swarm orchestration with DAG execution
  zouroboros-memory       Hybrid SQLite + vector memory engine

Install:
  zouroboros skills install              # Export all to ~/Skills/
  zouroboros skills install --skill autoloop  # Export one skill
  zouroboros skills install --dest ./my-skills # Custom directory
`);
      })
  );
