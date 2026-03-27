#!/usr/bin/env bun
/**
 * CLI for Zouroboros Swarm
 * 
 * Usage: zouroboros-swarm <tasks.json> [options]
 */

import { parseArgs } from 'util';
import { existsSync, readFileSync } from 'fs';
import { SwarmOrchestrator } from '../orchestrator.js';
import type { Task, SwarmConfig } from '../types.js';

function printHelp() {
  console.log(`
zouroboros-swarm — Multi-agent orchestration with circuit breakers and routing

USAGE:
  zouroboros-swarm <tasks.json> [options]
  zouroboros-swarm status
  zouroboros-swarm doctor

OPTIONS:
  --mode, -m           DAG mode: streaming | waves (default: streaming)
  --concurrency, -c    Max concurrent tasks (default: 8)
  --timeout, -t        Task timeout in seconds (default: 600)
  --strategy, -s       Routing strategy: fast | reliable | balanced | explore (default: balanced)
  --notify             Notification on complete: none | sms | email (default: none)
  --help, -h           Show this help

EXAMPLES:
  zouroboros-swarm ./tasks.json
  zouroboros-swarm ./tasks.json --mode waves --concurrency 4
  zouroboros-swarm ./tasks.json --strategy fast --notify email
  zouroboros-swarm doctor
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      mode: { type: 'string', short: 'm', default: 'streaming' },
      concurrency: { type: 'string', short: 'c', default: '8' },
      timeout: { type: 'string', short: 't', default: '600' },
      strategy: { type: 'string', short: 's', default: 'balanced' },
      notify: { type: 'string', default: 'none' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const command = positionals[0];

  if (command === 'doctor') {
    console.log('🔍 Running swarm health check...');
    const registry = JSON.parse(
      readFileSync('/home/workspace/Skills/zo-swarm-executors/registry/executor-registry.json', 'utf-8')
    );
    
    for (const executor of registry.executors) {
      if (executor.healthCheck) {
        process.stdout.write(`  ${executor.name}: `);
        try {
          const result = Bun.spawnSync(['bash', '-c', executor.healthCheck.command]);
          if (result.exitCode === 0) {
            console.log('✅');
          } else {
            console.log('❌ (not installed)');
          }
        } catch {
          console.log('❌ (check failed)');
        }
      }
    }
    process.exit(0);
  }

  if (command === 'status') {
    console.log('📊 Swarm Status');
    console.log('   Use --help for available commands');
    process.exit(0);
  }

  // Load tasks
  const tasksPath = command;
  if (!tasksPath) {
    console.error('Error: No tasks file specified');
    printHelp();
    process.exit(1);
  }

  if (!existsSync(tasksPath)) {
    console.error(`Error: Tasks file not found: ${tasksPath}`);
    process.exit(1);
  }

  let tasks: Task[];
  try {
    tasks = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    if (!Array.isArray(tasks)) {
      throw new Error('Tasks file must contain an array');
    }
  } catch (err: any) {
    console.error(`Error parsing tasks file: ${err.message}`);
    process.exit(1);
  }

  // Build config
  const config: Partial<SwarmConfig> = {
    dagMode: values.mode as SwarmConfig['dagMode'],
    localConcurrency: parseInt(values.concurrency as string, 10),
    timeoutSeconds: parseInt(values.timeout as string, 10),
    routingStrategy: values.strategy as SwarmConfig['routingStrategy'],
    notifyOnComplete: values.notify as SwarmConfig['notifyOnComplete'],
  };

  // Run orchestrator
  const orchestrator = new SwarmOrchestrator(config);
  const results = await orchestrator.run(tasks);

  // Exit with error if any task failed
  const failedCount = results.filter(r => !r.success).length;
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
