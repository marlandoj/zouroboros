#!/usr/bin/env bun
/**
 * score-execution-validation.ts — M10 W3 t7
 *
 * Reports on schema-fit pre-check outcomes recorded in tool_validations.
 * Surfaces pass rate, top failing roles/keys, and avg score.
 *
 * Usage:
 *   bun packages/selfheal/scripts/score-execution-validation.ts
 *   bun packages/selfheal/scripts/score-execution-validation.ts --json
 *   bun packages/selfheal/scripts/score-execution-validation.ts --tool claude-code
 *   bun packages/selfheal/scripts/score-execution-validation.ts --since 7
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { getMemoryDbPath } from 'zouroboros-core';
import { getValidationStats } from '../src/evolve/execution-validator.js';

function sqlite(sql: string): string {
  const db = getMemoryDbPath();
  if (!existsSync(db)) return '';
  try {
    return execSync(`sqlite3 "${db}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

interface Args {
  json: boolean;
  tool?: string;
  sinceDays?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--tool') args.tool = argv[++i];
    else if (a === '--since') args.sinceDays = parseInt(argv[++i] ?? '0', 10) || undefined;
  }
  return args;
}

function topMissingKeys(toolName?: string, sinceDays?: number): Array<{ key: string; count: number }> {
  const since = sinceDays ? Math.floor(Date.now() / 1000) - sinceDays * 86400 : 0;
  const wTool = toolName ? `AND tool_name='${toolName.replace(/'/g, "''")}'` : '';
  const wSince = since ? `AND created_at >= ${since}` : '';
  const where = `WHERE validation_outcome != 'pass' ${wTool} ${wSince}`.trim();
  const out = sqlite(`SELECT missing_keys FROM tool_validations ${where} LIMIT 5000`);
  if (!out) return [];

  const counts = new Map<string, number>();
  for (const row of out.split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(row) as string[];
      for (const k of parsed) counts.set(k, (counts.get(k) ?? 0) + 1);
    } catch {}
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function topRoles(toolName?: string, sinceDays?: number): Array<{ role: string; warnings: number }> {
  const since = sinceDays ? Math.floor(Date.now() / 1000) - sinceDays * 86400 : 0;
  const wTool = toolName ? `AND tool_name='${toolName.replace(/'/g, "''")}'` : '';
  const wSince = since ? `AND created_at >= ${since}` : '';
  const where = `WHERE validation_outcome != 'pass' AND role_id != '' ${wTool} ${wSince}`.trim();
  const out = sqlite(
    `SELECT role_id, COUNT(*) FROM tool_validations ${where} GROUP BY role_id ORDER BY 2 DESC LIMIT 10`
  );
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map(r => {
      const [role, count] = r.split('|');
      return { role: role ?? '', warnings: parseInt(count ?? '0', 10) };
    });
}

function main(): void {
  const args = parseArgs();
  const stats = getValidationStats({ toolName: args.tool, sinceDays: args.sinceDays });
  const missing = topMissingKeys(args.tool, args.sinceDays);
  const roles = topRoles(args.tool, args.sinceDays);

  if (args.json) {
    console.log(JSON.stringify({ stats, top_missing_keys: missing, top_offending_roles: roles }, null, 2));
    process.exit(0);
  }

  const scope = args.tool ? `tool=${args.tool}` : 'all tools';
  const window = args.sinceDays ? `last ${args.sinceDays}d` : 'all time';
  console.log(`\nExecution Validation Report (${scope}, ${window})`);
  console.log('='.repeat(60));
  console.log(`Total checks: ${stats.total}`);
  if (stats.total === 0) {
    console.log('No validation records yet — schema-fit pre-check has not run.');
    process.exit(0);
  }
  console.log(`  Pass:    ${stats.pass} (${(stats.passRate * 100).toFixed(1)}%)`);
  console.log(`  Warning: ${stats.warning}`);
  console.log(`  Fatal:   ${stats.fatal}`);
  console.log(`  Avg score: ${stats.avgScore.toFixed(2)}`);

  if (missing.length > 0) {
    console.log('\nTop missing keys:');
    for (const m of missing) console.log(`  • ${m.key}  (${m.count}×)`);
  }
  if (roles.length > 0) {
    console.log('\nTop offending roles:');
    for (const r of roles) console.log(`  • ${r.role}  (${r.warnings} warnings)`);
  }

  process.exit(0);
}

main();
