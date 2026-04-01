import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';

export const swarmCommand = new Command('swarm')
  .description('Swarm orchestration commands')
  .addCommand(
    new Command('run')
      .description('Run a swarm campaign')
      .argument('<tasks-file>', 'JSON file with tasks')
      .option('--strategy <strategy>', 'Routing strategy', 'balanced')
      .option('--max-concurrent <n>', 'Max concurrent tasks', '8')
      .action(async (tasksFile, options) => {
        if (!existsSync(tasksFile)) {
          console.log(chalk.red(`Error: Tasks file not found: ${tasksFile}`));
          process.exit(1);
        }
        
        // Import and run orchestrator
        const { SwarmOrchestrator } = await import('zouroboros-swarm');
        const orchestrator = new SwarmOrchestrator({
          routingStrategy: options.strategy,
          localConcurrency: parseInt(options.maxConcurrent),
        });
        
        const { readFileSync } = await import('fs');
        const tasks = JSON.parse(readFileSync(tasksFile, 'utf-8'));
        const results = await orchestrator.run(tasks);
        const successCount = results.filter((r: any) => r.success).length;
        console.log(chalk.green(`\n✅ Campaign complete: ${successCount}/${results.length} tasks succeeded`));
      })
  )
  .addCommand(
    new Command('status')
      .description('Check swarm status')
      .action(() => {
        console.log(chalk.cyan('Swarm status: Ready'));
      })
  );