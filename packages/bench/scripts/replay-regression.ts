#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ReplayRegressionTarget = 'zourobench' | 'snakepit' | 'crystallization';

interface ReplayCorpusResult {
  passed: number;
  total: number;
  failed: number;
  errors: number;
  results: Array<{ id: string; status: 'pass' | 'fail' | 'error'; detail?: string }>;
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: 'string', default: 'zourobench' },
    root: { type: 'string' },
    corpus: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
  strict: true,
});

const target = values.target as ReplayRegressionTarget;
if (!['zourobench', 'snakepit', 'crystallization'].includes(target)) {
  console.error(`invalid replay target: ${target}`);
  process.exit(3);
}

const projectRoot = resolve(values.root ?? join(import.meta.dir, '..', '..', '..'));
const corpusDir = resolve(values.corpus ?? join(projectRoot, 'Seeds', 'zouroboros', 'replay'));
const preloadPath = join(projectRoot, 'packages', 'selfheal', 'src', 'replay', 'preload.ts');
const replayModulePath = join(projectRoot, 'packages', 'selfheal', 'src', 'replay', 'regression.ts');
const { runReplayCorpus } = (await import(pathToFileURL(replayModulePath).href)) as {
  runReplayCorpus(options: {
    corpusDir: string;
    target: ReplayRegressionTarget;
    projectRoot: string;
    preloadPath: string;
  }): Promise<ReplayCorpusResult>;
};

const result = await runReplayCorpus({ corpusDir, target, projectRoot, preloadPath });
if (values.json) console.log(JSON.stringify(result));
else {
  console.log(`Replay regression (${target}): ${result.passed}/${result.total} passed, ${result.failed} failed, ${result.errors} errors`);
  for (const item of result.results.filter((entry) => entry.status !== 'pass')) {
    console.log(`  ${item.status.toUpperCase()} ${item.id}: ${item.detail ?? ''}`);
  }
}

process.exit(result.failed > 0 || result.errors > 0 ? 1 : 0);
