import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig } from 'zouroboros-core';
import { join } from 'path';
import { homedir } from 'os';

export const configCommand = new Command('config')
  .description('Manage Zouroboros configuration')
  .addCommand(
    new Command('get')
      .description('Get a configuration value')
      .argument('<key>', 'Configuration key (dot notation)')
      .action((key) => {
        const config = loadConfig();
        const value = key.split('.').reduce((obj, k) => obj?.[k], config as any);
        
        if (value === undefined) {
          console.log(chalk.yellow(`Key '${key}' not found`));
          process.exit(1);
        }
        
        console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
      })
  )
  .addCommand(
    new Command('set')
      .description('Set a configuration value')
      .argument('<key>', 'Configuration key (dot notation)')
      .argument('<value>', 'Value to set')
      .action((key, value) => {
        const configPath = join(homedir(), '.zouroboros', 'config.json');
        const config = loadConfig(configPath);
        
        const keys = key.split('.');
        let target: any = config;
        
        for (let i = 0; i < keys.length - 1; i++) {
          if (!target[keys[i]]) target[keys[i]] = {};
          target = target[keys[i]];
        }
        
        // Try to parse as JSON, fallback to string
        try {
          target[keys[keys.length - 1]] = JSON.parse(value);
        } catch {
          target[keys[keys.length - 1]] = value;
        }
        
        saveConfig(config, configPath);
        console.log(chalk.green(`✅ Set ${key} = ${value}`));
      })
  )
  .addCommand(
    new Command('list')
      .description('List all configuration values')
      .alias('ls')
      .action(() => {
        const config = loadConfig();
        console.log(chalk.cyan('\nZouroboros Configuration:\n'));
        console.log(JSON.stringify(config, null, 2));
        console.log();
      })
  );