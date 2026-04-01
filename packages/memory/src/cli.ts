#!/usr/bin/env bun
import { parseArgs } from 'util';
import { VERSION } from './index.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    stats: { type: 'boolean', short: 's' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

function printHelp() {
  console.log(`
zouroboros-memory — Hybrid SQLite + Vector memory system

USAGE:
  zouroboros-memory [options]

OPTIONS:
  --stats, -s    Show memory database statistics
  --version, -v  Show version
  --help, -h     Show this help

PROGRAMMATIC USAGE:
  import { init, storeFact, searchFacts } from 'zouroboros-memory';
`);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

if (values.version) {
  console.log(`zouroboros-memory v${VERSION}`);
  process.exit(0);
}

if (values.stats) {
  console.log('Memory system statistics:');
  console.log('  Run "zouroboros doctor" for a full health check.');
  console.log('  Or use the programmatic API: import { getStats } from "zouroboros-memory"');
  process.exit(0);
}

printHelp();
