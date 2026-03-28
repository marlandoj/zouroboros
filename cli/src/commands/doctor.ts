import { Command } from 'commander';
import chalk from 'chalk';
import { runDoctor } from '../utils/doctor.js';

export const doctorCommand = new Command('doctor')
  .description('Run health check on all Zouroboros components')
  .option('--fix', 'Attempt to fix issues automatically')
  .action(async (options) => {
    console.log(chalk.cyan('\n🔍 Zouroboros Health Check\n'));
    
    const healthy = await runDoctor({ fix: options.fix });
    
    if (healthy) {
      console.log(chalk.green('\n✅ All systems healthy\n'));
      process.exit(0);
    } else {
      console.log(chalk.yellow('\n⚠️  Some issues found\n'));
      process.exit(1);
    }
  });