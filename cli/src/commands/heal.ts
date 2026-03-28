import { Command } from 'commander';
import chalk from 'chalk';

export const healCommand = new Command('heal')
  .description('Self-healing system commands')
  .addCommand(
    new Command('introspect')
      .description('Run health introspection')
      .option('--json', 'Output as JSON')
      .option('--store', 'Store as memory episode')
      .action(async (options) => {
        const { introspect } = await import('zouroboros-selfheal');
        const scorecard = await introspect({
          json: options.json,
          store: options.store,
        });
        
        if (options.json) {
          console.log(JSON.stringify(scorecard, null, 2));
        }
      })
  )
  .addCommand(
    new Command('prescribe')
      .description('Generate improvement prescription')
      .option('--live', 'Run introspect live')
      .option('--target <metric>', 'Target specific metric')
      .action(async (options) => {
        console.log(chalk.cyan('\n🔬 Generating prescription...\n'));
        const { prescribe } = await import('zouroboros-selfheal');
        const prescription = await prescribe({
          live: options.live,
          target: options.target,
        });
        console.log(chalk.green('✅ Prescription generated'));
        console.log(chalk.gray(`   Metric: ${prescription.metric.name}`));
        console.log(chalk.gray(`   Playbook: ${prescription.playbook.id}\n`));
      })
  )
  .addCommand(
    new Command('evolve')
      .description('Execute prescribed improvement')
      .requiredOption('--prescription <path>', 'Prescription file')
      .action(async (options) => {
        console.log(chalk.cyan('\n🧬 Executing evolution...\n'));
        const { evolve } = await import('zouroboros-selfheal');
        const result = await evolve({
          prescription: options.prescription,
        });
        
        if (result.success) {
          console.log(chalk.green('✅ Evolution complete'));
          console.log(chalk.gray(`   Delta: ${result.delta}\n`));
        } else {
          console.log(chalk.red('❌ Evolution failed'));
          console.log(chalk.gray(`   Error: ${result.error}\n`));
        }
      })
  );