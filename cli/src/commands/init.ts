import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import {
  saveConfig,
  DEFAULT_CONFIG,
  createMigrationRunner,
  MIGRATIONS,
} from 'zouroboros-core';
import { runDoctor } from '../utils/doctor.js';
import { installBundledSkills } from '../utils/skills-laydown.js';
import { resolveDefaultSkillsDest } from './skills.js';

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

    // Initialize memory database
    console.log(chalk.cyan('💾 Initializing memory database...'));
    try {
      // Honor ZOUROBOROS_MEMORY_DB / ZO_MEMORY_DB if set (issue #71) so that
      // Zo Computer users and anyone pointing at a shared DB land on the
      // right file instead of the hardcoded default.
      const envDbPath = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
      const dbPath = envDbPath || config.memory.dbPath;
      if (envDbPath && envDbPath !== config.memory.dbPath) {
        config.memory.dbPath = envDbPath;
        saveConfig(config, configPath);
        console.log(
          chalk.gray(
            `   Using ZOUROBOROS_MEMORY_DB override: ${envDbPath}`,
          ),
        );
      }
      const dbDir = join(dbPath, '..');
      mkdirSync(dbDir, { recursive: true });

      // Create the base schema natively via bun:sqlite — no external `sqlite3`
      // binary and no `/bin/bash`, both of which are absent on minimal boxes
      // (e.g. Alpine). The CLI is bun-only, so bun:sqlite is always available.
      const schemaSql = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  persona TEXT,
  entity TEXT NOT NULL,
  key TEXT,
  value TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT DEFAULT 'fact' CHECK(category IN ('preference', 'fact', 'decision', 'convention', 'other', 'reference', 'project')),
  decay_class TEXT DEFAULT 'medium' CHECK(decay_class IN ('permanent', 'long', 'medium', 'short')),
  importance REAL DEFAULT 1.0,
  source TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  expires_at INTEGER,
  last_accessed INTEGER DEFAULT (strftime('%s', 'now')),
  confidence REAL DEFAULT 1.0,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT DEFAULT 'text-embedding-3-small',
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'resolved', 'ongoing')),
  happened_at INTEGER NOT NULL,
  duration_ms INTEGER,
  procedure_id TEXT,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity)
);

CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  steps TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  evolved_from TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  entity TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  priority INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS continuation_context (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  last_summary TEXT NOT NULL,
  open_loop_ids TEXT,
  entity_stack TEXT,
  last_agent TEXT,
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS cognitive_profiles (
  entity TEXT PRIMARY KEY,
  traits TEXT,
  preferences TEXT,
  interaction_count INTEGER DEFAULT 0,
  last_interaction INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class, expires_at);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
CREATE INDEX IF NOT EXISTS idx_episode_entities ON episode_entities(entity);
CREATE INDEX IF NOT EXISTS idx_open_loops_entity ON open_loops(entity, status);
`;

      const { Database } = await import('bun:sqlite');
      const memDb = new Database(dbPath);
      memDb.exec(schemaSql);

      console.log(chalk.green('✅ Memory database initialized'));
      console.log(chalk.gray(`   ${dbPath}`));

      // Run built-in migrations so the fresh DB reaches the full schema
      // (FTS5 tables, fact_links, episode_documents, upgraded open_loops,
      // etc.). Without this, standalone scripts would silently create
      // partial schemas lazily on first use — see issues #69, #70.
      try {
        const runner = createMigrationRunner(memDb);
        const result = runner.migrate();
        if (result.errors.length > 0) {
          console.log(
            chalk.yellow(
              `⚠️  ${result.errors.length} migration(s) failed — run \`zouroboros migrate up\` for details`,
            ),
          );
        } else if (result.applied.length > 0) {
          console.log(
            chalk.gray(`   Applied ${result.applied.length} migrations (up to #${MIGRATIONS[MIGRATIONS.length - 1].id})\n`),
          );
        } else {
          console.log('');
        }
      } catch (err) {
        console.log(
          chalk.yellow('⚠️  Migrations could not be auto-applied — run `zouroboros migrate up`'),
        );
        console.log(chalk.gray(`   ${err instanceof Error ? err.message : String(err)}\n`));
      } finally {
        memDb.close();
      }
    } catch (error) {
      console.log(chalk.yellow('⚠️  Memory database initialization failed — will be created on first use'));
      console.log(chalk.gray(`   ${error instanceof Error ? error.message : String(error)}\n`));
    }

    // Embeddings (PR #87 dropped Ollama; OpenAI-only via text-embedding-3-small)
    if (process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY) {
      console.log(chalk.green('✅ OPENAI_API_KEY detected — embeddings ready\n'));
    } else {
      console.log(chalk.yellow('⚠️  OPENAI_API_KEY not set — vector search will fail until exported.'));
      console.log(chalk.gray('   export OPENAI_API_KEY=sk-...\n'));
    }

    // Bootstrap the memory-gate bearer token (fail-closed auth for the daemon).
    // Written to ~/.zouroboros/.env so `zouroboros gate start` and the hook shim
    // can source it. Never printed — only its presence is reported.
    const envFile = join(configDir, '.env');
    let hasToken = !!process.env.ZO_GATE_TOKEN;
    if (!hasToken && existsSync(envFile)) {
      hasToken = /^ZO_GATE_TOKEN=.+/m.test(readFileSync(envFile, 'utf-8'));
    }
    if (hasToken) {
      console.log(chalk.green('✅ ZO_GATE_TOKEN already present — memory-gate auth ready\n'));
    } else {
      const token = randomBytes(32).toString('hex');
      const line = `ZO_GATE_TOKEN=${token}\n`;
      if (existsSync(envFile)) {
        appendFileSync(envFile, line);
      } else {
        writeFileSync(envFile, line, { mode: 0o600 });
      }
      console.log(chalk.green('✅ Memory-gate token generated'));
      console.log(chalk.gray(`   ${envFile} (keep private — do not commit)`));
      console.log(chalk.gray('   source it before `zouroboros gate start`\n'));
    }

    // Lay down the bundled MVP skills from the packaged skills/ home into the
    // workspace Skills dir (honors ZOUROBOROS_SKILLS_DIR / workspace / ~/Skills).
    try {
      const skillsDest = resolveDefaultSkillsDest();
      const { installed, source } = installBundledSkills(skillsDest);
      if (installed.length > 0) {
        console.log(chalk.green(`✅ Installed ${installed.length} skill(s)`));
        console.log(chalk.gray(`   ${skillsDest}\n`));
      } else {
        console.log(chalk.yellow('⚠️  No bundled skills found — skipping skill install'));
        console.log(chalk.gray(`   looked in ${source}\n`));
      }
    } catch (error) {
      console.log(chalk.yellow('⚠️  Skill install failed — run `zouroboros skills install` later'));
      console.log(chalk.gray(`   ${error instanceof Error ? error.message : String(error)}\n`));
    }

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
