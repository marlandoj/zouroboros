import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from 'zouroboros-core';
import { runDoctor } from '../utils/doctor.js';

export const initCommand = new Command('init')
  .description('Initialize Zouroboros configuration')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('--skip-doctor', 'Skip health check after initialization')
  .action(async (options) => {
    console.log(chalk.cyan('\n🐍⭕ Initializing Zouroboros...\n'));

    const configDir = join(homedir(), '.zouroboros');
    const configPath = join(configDir, 'config.json');

    // Check if already initialized
    if (existsSync(configPath) && !options.force) {
      console.log(chalk.yellow('⚠️  Zouroboros is already initialized.'));
      console.log(chalk.gray(`   Config: ${configPath}`));
      console.log(chalk.gray('\n   Use --force to reinitialize.\n'));
      return;
    }

    // Create config directory
    mkdirSync(configDir, { recursive: true });

    // Create default configuration
    const config = {
      ...DEFAULT_CONFIG,
      initializedAt: new Date().toISOString(),
    };

    saveConfig(config, configPath);

    console.log(chalk.green('✅ Configuration created'));
    console.log(chalk.gray(`   ${configPath}\n`));

    // Create workspace directories
    const workspaceDirs = [
      join(configDir, 'logs'),
      join(configDir, 'seeds'),
      join(configDir, 'results'),
    ];

    for (const dir of workspaceDirs) {
      mkdirSync(dir, { recursive: true });
    }

    console.log(chalk.green('✅ Workspace directories created'));
    console.log(chalk.gray(`   ${configDir}/{logs,seeds,results}\n`));

    // Run doctor unless skipped
    if (!options.skipDoctor) {
      console.log(chalk.cyan('🔍 Running health check...\n'));
      const healthy = await runDoctor();
      
      if (healthy) {
        console.log(chalk.green('\n✅ Zouroboros is ready to use!\n'));
        console.log('Next steps:');
        console.log(chalk.yellow('  zouroboros doctor') + chalk.gray('     - Check system health'));
        console.log(chalk.yellow('  zouroboros --help') + chalk.gray('     - See all commands'));
        console.log(chalk.yellow('  zouroboros tui') + chalk.gray('        - Launch dashboard\n'));
      } else {
        console.log(chalk.yellow('\n⚠️  Some components need attention.\n'));
        console.log('Run ' + chalk.yellow('zouroboros doctor') + ' for details.\n');
      }
    } else {
      console.log(chalk.green('\n✅ Initialization complete!\n'));
    }
  });