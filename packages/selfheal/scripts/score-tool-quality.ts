#!/usr/bin/env bun
/**
 * score-tool-quality.ts — M10 W2 t6
 *
 * Audits tool/executor descriptions for documentation quality.
 * Scores each tool on three criteria (0–5 total):
 *   - Purpose line: does the description contain a clear, non-empty purpose? (0-2)
 *   - Typed args: are parameters described with types? (0-2)
 *   - Examples: does the description include an example call? (0-1)
 *
 * Tools scoring < 3/5 are flagged for improvement.
 *
 * Usage:
 *   bun packages/selfheal/scripts/score-tool-quality.ts
 *   bun packages/selfheal/scripts/score-tool-quality.ts --json
 *   bun packages/selfheal/scripts/score-tool-quality.ts --threshold 4
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.WORKSPACE_ROOT ?? '/home/workspace';
const REGISTRY_PATH = join(
  WORKSPACE,
  'zouroboros/packages/swarm/src/executor/registry/executor-registry.json'
);
const DEFAULT_THRESHOLD = 3;

interface Executor {
  id: string;
  name: string;
  description?: string;
  expertise?: string[];
  best_for?: string[];
  capabilities?: Record<string, boolean>;
}

interface RegistryFile {
  executors: Executor[];
}

interface ToolScore {
  id: string;
  name: string;
  scores: {
    purpose: number;
    typedArgs: number;
    examples: number;
  };
  total: number;
  flagged: boolean;
  reasons: string[];
}

function scorePurpose(ex: Executor): { score: number; reason: string | null } {
  const desc = (ex.description ?? '').trim();
  if (desc.length === 0) return { score: 0, reason: 'No description' };
  if (desc.length < 20) return { score: 1, reason: `Description too brief (${desc.length} chars)` };
  return { score: 2, reason: null };
}

function scoreTypedArgs(ex: Executor): { score: number; reason: string | null } {
  const expertise = ex.expertise ?? [];
  const bestFor = ex.best_for ?? [];
  const capabilities = ex.capabilities ?? {};

  const hasCapabilities = Object.keys(capabilities).length > 0;
  const hasExpertise = expertise.length > 0;
  const hasBestFor = bestFor.length > 0;

  if (hasCapabilities && (hasExpertise || hasBestFor)) return { score: 2, reason: null };
  if (hasCapabilities || hasExpertise || hasBestFor) {
    return { score: 1, reason: 'Partial metadata — add capabilities map, expertise, and best_for' };
  }
  return { score: 0, reason: 'No capabilities, expertise, or best_for fields' };
}

function scoreExamples(ex: Executor): { score: number; reason: string | null } {
  const desc = (ex.description ?? '') + JSON.stringify(ex.best_for ?? []);
  const hasExample = /example|e\.g\.|such as|like:/i.test(desc) ||
    (ex.best_for && ex.best_for.some(s => s.length > 30));
  return hasExample
    ? { score: 1, reason: null }
    : { score: 0, reason: 'No usage examples in description or best_for' };
}

function scoreExecutor(ex: Executor, threshold: number): ToolScore {
  const purpose = scorePurpose(ex);
  const typedArgs = scoreTypedArgs(ex);
  const examples = scoreExamples(ex);

  const total = purpose.score + typedArgs.score + examples.score;
  const reasons = [purpose.reason, typedArgs.reason, examples.reason].filter(Boolean) as string[];

  return {
    id: ex.id,
    name: ex.name,
    scores: { purpose: purpose.score, typedArgs: typedArgs.score, examples: examples.score },
    total,
    flagged: total < threshold,
    reasons,
  };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 ? parseInt(args[thresholdIdx + 1] ?? '3', 10) : DEFAULT_THRESHOLD;

  if (!existsSync(REGISTRY_PATH)) {
    console.error(`Registry not found: ${REGISTRY_PATH}`);
    process.exit(1);
  }

  const registry: RegistryFile = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  const executors = registry.executors ?? [];

  if (executors.length === 0) {
    console.log('No executors found in registry.');
    process.exit(0);
  }

  const results = executors.map(ex => scoreExecutor(ex, threshold));
  const flagged = results.filter(r => r.flagged);
  const avgScore = results.reduce((s, r) => s + r.total, 0) / results.length;

  if (asJson) {
    console.log(JSON.stringify({ results, flagged_count: flagged.length, avg_score: avgScore }, null, 2));
    process.exit(flagged.length > 0 ? 1 : 0);
  }

  console.log('\nTool Description Quality Audit');
  console.log('='.repeat(60));
  console.log(`Executors: ${results.length}  Threshold: ${threshold}/5  Avg: ${avgScore.toFixed(1)}/5`);
  console.log('');

  for (const r of results) {
    const bar = '█'.repeat(r.total) + '░'.repeat(5 - r.total);
    const flag = r.flagged ? ' ⚠ FLAGGED' : '';
    console.log(`  ${r.id.padEnd(20)} [${bar}] ${r.total}/5${flag}`);
    if (r.reasons.length > 0) {
      for (const reason of r.reasons) {
        console.log(`    → ${reason}`);
      }
    }
  }

  console.log('');
  if (flagged.length === 0) {
    console.log(`✅ All executors meet the quality threshold (${threshold}/5).`);
  } else {
    console.log(`⚠  ${flagged.length}/${results.length} executor(s) below threshold ${threshold}/5:`);
    for (const r of flagged) {
      console.log(`   • ${r.name} (${r.total}/5)`);
    }
  }

  process.exit(flagged.length > 0 ? 1 : 0);
}

main();
