import { Command } from 'commander';
import chalk from 'chalk';

export const omnirouteCommand = new Command('omniroute')
  .description('OmniRoute integration commands')
  .addCommand(
    new Command('resolve')
      .description('Resolve task to optimal combo')
      .argument('<task>', 'Task description')
      .option('--json', 'Output full JSON')
      .action(async (task, options) => {
        const { resolveTask } = await import('zouroboros-omniroute');
        const result = await resolveTask(task);
        
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\n🎯 Task Analysis\n'));
          console.log(`Task: ${task.slice(0, 80)}${task.length > 80 ? '...' : ''}`);
          console.log(`Tier: ${chalk.bold(result.complexity.tier)}`);
          console.log(`Type: ${result.complexity.inferredTaskType}`);
          console.log(`Combo: ${chalk.green(result.resolvedCombo)}\n`);
        }
      })
  )
  .addCommand(
    new Command('status')
      .description('Check OmniRoute status')
      .action(async () => {
        const { checkHealth } = await import('zouroboros-omniroute');
        const health = await checkHealth();
        
        if (health.ok) {
          console.log(chalk.green('✅ OmniRoute is healthy'));
          console.log(chalk.gray(`   URL: ${health.url}`));
          console.log(chalk.gray(`   Combos: ${health.comboCount}\n`));
        } else {
          console.log(chalk.yellow('⚠️  OmniRoute unavailable'));
          console.log(chalk.gray(`   Will use static fallback\n`));
        }
      })
  );