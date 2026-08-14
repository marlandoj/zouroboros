#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessContract, renderCompatibilityMatrix } from '../src/executor/portability.ts';

const outputPath = join(import.meta.dir, '..', 'docs', 'executors', 'harness-compatibility.md');
const rendered = renderCompatibilityMatrix(loadHarnessContract());
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== rendered) throw new Error('Harness compatibility matrix is stale');
} else {
  writeFileSync(outputPath, rendered);
}
