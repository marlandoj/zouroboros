import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';

const PACKAGES = resolve(import.meta.dirname || __dirname, '../../../packages');

function runCli(pkg: string, cli: string, args: string[] = []) {
  const script = join(PACKAGES, pkg, 'src/cli', `${cli}.ts`);
  if (!existsSync(script)) {
    console.log(
      chalk.yellow(`\n'${pkg} ${cli}' is not part of the Zouroboros MVP bundle.`)
    );
    console.log(
      chalk.gray(
        `It needs the optional 'zouroboros-${pkg}' package. Install the full workspace to enable it.`
      )
    );
    process.exit(1);
  }
  const child = spawn('bun', [script, ...args], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

export const workflowCommand = new Command('workflow')
  .description('Workflow tools (interview, evaluate, unstuck, autoloop)')
  .addCommand(
    new Command('interview')
      .description('Run spec-first interview')
      .option('--topic <topic>', 'Interview topic')
      .action((options) => {
        const args = options.topic ? ['--topic', options.topic] : [];
        runCli('workflow', 'interview', args);
      })
      .addCommand(
        new Command('seed')
          .description('Generate a seed YAML from a topic and/or interview notes')
          .option('--topic <topic>', 'Seed topic')
          .option('--from <path>', 'Path to interview notes markdown file')
          .option('--output <dir>', 'Output directory for the seed file', '.')
          .action((options, command) => {
            // `--topic` is also declared on the parent `interview` command, so
            // commander may bind it at the parent scope; merge globals to be safe.
            const merged = { ...command.optsWithGlobals(), ...options };
            const args = ['seed'];
            if (merged.topic) args.push('--topic', merged.topic);
            if (merged.from) args.push('--from', merged.from);
            if (merged.output) args.push('--output', merged.output);
            runCli('workflow', 'interview', args);
          })
      )
      .addCommand(
        new Command('score')
          .description('Score the ambiguity of a request')
          .requiredOption('--request <text>', 'Request text to score')
          .action((options) => {
            runCli('workflow', 'interview', ['score', '--request', options.request]);
          })
      )
  )
  .addCommand(
    new Command('evaluate')
      .description('Run three-stage evaluation')
      .option('--seed <path>', 'Seed specification file')
      .option('--artifact <path>', 'Artifact to evaluate')
      .option('--stage <n>', 'Run only this stage (1, 2, or 3)')
      .option('--self-test', 'Run Stage 1 checks against the current workspace')
      .option('--output <dir>', 'Output directory for the evaluation report')
      .action((options) => {
        const args: string[] = [];
        if (options.selfTest) args.push('--self-test');
        if (options.seed) args.push('--seed', options.seed);
        if (options.artifact) args.push('--artifact', options.artifact);
        if (options.stage) args.push('--stage', options.stage);
        if (options.output) args.push('--output', options.output);
        runCli('workflow', 'evaluate', args);
      })
  )
  .addCommand(
    new Command('unstuck')
      .description('Run unstuck lateral thinking')
      .argument('<problem>', 'Description of what you are stuck on')
      .action((problem) => {
        runCli('workflow', 'unstuck', [problem]);
      })
  )
  .addCommand(
    new Command('autoloop')
      .description('Run autoloop optimization')
      .requiredOption('--program <path>', 'Program.md file')
      .action((options) => {
        runCli('workflow', 'autoloop', ['--program', options.program]);
      })
  );

export const selfhealCommand = new Command('selfheal')
  .description('Self-enhancement tools (introspect, prescribe, evolve)')
  .addCommand(
    new Command('introspect')
      .description('Run 7-metric health scorecard')
      .option('--json', 'Output raw JSON')
      .option('--store', 'Persist scorecard')
      .option('--verbose', 'Print formatted table')
      .action((options) => {
        const args: string[] = [];
        if (options.json) args.push('--json');
        if (options.store) args.push('--store');
        if (options.verbose) args.push('--verbose');
        runCli('selfheal', 'introspect', args);
      })
  )
  .addCommand(
    new Command('prescribe')
      .description('Generate improvement prescription')
      .option('--scorecard <path>', 'Path to scorecard JSON')
      .option('--target <metric>', 'Target metric name')
      .option('--live', 'Run live introspection')
      .option('--dry-run', 'Preview without writing')
      .action((options) => {
        const args: string[] = [];
        if (options.scorecard) args.push('--scorecard', options.scorecard);
        if (options.target) args.push('--target', options.target);
        if (options.live) args.push('--live');
        if (options.dryRun) args.push('--dry-run');
        runCli('selfheal', 'prescribe', args);
      })
  )
  .addCommand(
    new Command('evolve')
      .description('Execute prescription with regression detection')
      .option('--prescription <path>', 'Path to prescription JSON')
      .option('--dry-run', 'Preview without changes')
      .option('--skip-governor', 'Bypass governor safety gate')
      .action((options) => {
        const args: string[] = [];
        if (options.prescription) args.push('--prescription', options.prescription);
        if (options.dryRun) args.push('--dry-run');
        if (options.skipGovernor) args.push('--skip-governor');
        runCli('selfheal', 'evolve', args);
      })
  );
