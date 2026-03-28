import { Command } from 'commander';
import { spawn } from 'child_process';
import { join } from 'path';

const WORKSPACE = process.env.ZO_WORKSPACE || '/home/workspace';

export const workflowCommand = new Command('workflow')
  .description('Workflow tools (interview, evaluate, unstuck, autoloop)')
  .addCommand(
    new Command('interview')
      .description('Run spec-first interview')
      .option('--topic <topic>', 'Interview topic')
      .action((options) => {
        const args = options.topic ? ['--topic', options.topic] : [];
        spawn('bun', [join(WORKSPACE, 'Skills/spec-first-interview/scripts/interview.ts'), ...args], {
          stdio: 'inherit'
        });
      })
  )
  .addCommand(
    new Command('evaluate')
      .description('Run three-stage evaluation')
      .requiredOption('--seed <path>', 'Seed specification file')
      .requiredOption('--artifact <path>', 'Artifact to evaluate')
      .action((options) => {
        spawn('bun', [join(WORKSPACE, 'Skills/three-stage-eval/scripts/evaluate.ts'),
          '--seed', options.seed,
          '--artifact', options.artifact
        ], { stdio: 'inherit' });
      })
  )
  .addCommand(
    new Command('unstuck')
      .description('Run unstuck lateral thinking')
      .argument('<problem>', 'Description of what you are stuck on')
      .action((problem) => {
        spawn('bun', [join(WORKSPACE, 'Skills/unstuck-lateral/scripts/unstuck.ts'), problem], {
          stdio: 'inherit'
        });
      })
  )
  .addCommand(
    new Command('autoloop')
      .description('Run autoloop optimization')
      .requiredOption('--program <path>', 'Program.md file')
      .action((options) => {
        spawn('bun', [join(WORKSPACE, 'Skills/autoloop/scripts/autoloop.ts'),
          '--program', options.program
        ], { stdio: 'inherit' });
      })
  );