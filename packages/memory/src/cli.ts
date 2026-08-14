#!/usr/bin/env bun
import { parseArgs } from 'util';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { VERSION, init } from './index.js';
import { storeFact, searchFacts } from './facts.js';
import { loadConfig } from 'zouroboros-core';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    stats: { type: 'boolean', short: 's' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
  allowPositionals: true,
});

function printHelp() {
  console.log(`
zouroboros-memory v${VERSION} — Hybrid SQLite + Vector memory system

USAGE:
  zouroboros-memory [options]
  zouroboros-memory <command> [args]

OPTIONS:
  --stats, -s    Show memory database statistics
  --version, -v  Show version
  --help, -h     Show this help

COMMANDS (v4 enhancements):
  metrics [report|record|clear]     Memory system metrics dashboard (MEM-101)
  import --source <type> --path <p> Import from external sources (MEM-102)
  budget [init|status|track|reset]  Context budget tracking (MEM-001)
  summarize [args]                  Episode summarization (MEM-002)
  multi-hop [retrieve|benchmark]    Multi-hop retrieval (MEM-003)
  conflicts [detect|resolve|stats]  Conflict resolution (MEM-103)
  cross-persona [args]              Cross-persona memory (MEM-104)
  graph-traversal [args]            Graph traversal tools (MEM-105)
  embed-bench [compare|benchmark]   Embedding model benchmark (MEM-202)

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

const command = positionals[0];

// Core MVP commands — store/search a fact through the programmatic API. These
// are the documented quickstart commands; without them `zouroboros memory
// store|search` falls through to help and silently does nothing.
if (command === 'store' || command === 'search') {
  const config = loadConfig();
  const memoryConfig = { ...config.memory };
  const envDb = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
  if (envDb) memoryConfig.dbPath = envDb;
  init(memoryConfig);

  const sub = parseArgs({
    args: process.argv.slice(3),
    options: {
      entity: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      persona: { type: 'string' },
      limit: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });
  const v = sub.values as Record<string, string | undefined>;

  if (command === 'store') {
    if (!v.entity || !v.value) {
      console.error(
        'Usage: zouroboros-memory store --entity <entity> [--key <key>] --value <value> [--persona <slug>]',
      );
      process.exit(1);
    }
    const entry = await storeFact(
      { entity: v.entity, key: v.key, value: v.value, persona: v.persona },
      memoryConfig,
    );
    const label = entry.key ? `${entry.entity}.${entry.key}` : entry.entity;
    console.log(`✅ Stored ${label} = ${entry.value}`);
    process.exit(0);
  }

  const query = sub.positionals.join(' ').trim();
  if (!query) {
    console.error('Usage: zouroboros-memory search <query> [--limit <n>] [--persona <slug>]');
    process.exit(1);
  }
  const limit = v.limit ? parseInt(v.limit, 10) : 10;
  const results = searchFacts(query, { persona: v.persona, limit });
  if (results.length === 0) {
    console.log(`No stored memory matches "${query}".`);
    process.exit(0);
  }
  console.log(`Found ${results.length} result(s) for "${query}":`);
  for (const r of results) {
    const label = r.key ? `${r.entity}.${r.key}` : r.entity;
    console.log(`  ${label} = ${r.value}`);
  }
  process.exit(0);
}

// v4 subcommand routing — delegates to individual script CLIs
if (command) {
  const { execSync } = require('child_process');
  // When running from the compiled dist/ output, import.meta.dir points at
  // packages/memory/dist/. The subcommand scripts are Bun-native .ts files
  // that only live under src/, so map dist → src at runtime. See issue #74.
  const thisDir = import.meta.dir;
  const candidateSrcDir = thisDir.replace(/(^|\/)dist(\/|$)/, '$1src$2');
  const srcDir =
    candidateSrcDir !== thisDir && existsSync(candidateSrcDir)
      ? candidateSrcDir
      : thisDir;
  const subArgs = process.argv.slice(3).join(' ');

  const commandMap: Record<string, string> = {
    'metrics': 'metrics.ts',
    'import': 'import-pipeline.ts',
    'budget': 'context-budget.ts',
    'summarize': 'episode-summarizer.ts',
    'multi-hop': 'multi-hop.ts',
    'conflicts': 'conflict-resolver.ts',
    'cross-persona': 'cross-persona.ts',
    'graph-traversal': 'graph-traversal.ts',
    'embed-bench': 'embedding-benchmark.ts',
  };

  const scriptFile = commandMap[command];
  if (scriptFile) {
    const scriptPath = join(srcDir, scriptFile);
    try {
      execSync(`bun "${scriptPath}" ${subArgs}`, { stdio: 'inherit' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Command "${command}" failed: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

printHelp();
