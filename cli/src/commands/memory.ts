import { Command } from 'commander';
import { spawn } from 'child_process';
import { join } from 'path';

const MEMORY_SCRIPT = join(process.env.ZO_WORKSPACE || '/home/workspace', 
  'Skills/zo-memory-system/scripts/memory.ts');

export const memoryCommand = new Command('memory')
  .description('Memory system commands')
  .addCommand(
    new Command('search')
      .description('Search memory')
      .argument('<query>', 'Search query')
      .option('--limit <n>', 'Limit results', '10')
      .action((query, options) => {
        spawn('bun', [MEMORY_SCRIPT, 'search', query, '--limit', options.limit], {
          stdio: 'inherit'
        });
      })
  )
  .addCommand(
    new Command('store')
      .description('Store a fact')
      .requiredOption('--entity <entity>', 'Entity name')
      .requiredOption('--key <key>', 'Key')
      .requiredOption('--value <value>', 'Value')
      .action((options) => {
        spawn('bun', [MEMORY_SCRIPT, 'store', 
          '--entity', options.entity,
          '--key', options.key,
          '--value', options.value
        ], { stdio: 'inherit' });
      })
  )
  .addCommand(
    new Command('stats')
      .description('Show memory statistics')
      .action(() => {
        spawn('bun', [MEMORY_SCRIPT, 'stats'], { stdio: 'inherit' });
      })
  );