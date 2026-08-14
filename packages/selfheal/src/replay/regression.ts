import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateReplay, type ReplayTrace } from '../crystallize/eval-replay.js';
import { loadCassette } from './cassette.js';

export const REPLAY_REGRESSION_SCHEMA = 'zouroboros-replay-regression/v1' as const;

export type ReplayRegressionTarget = 'zourobench' | 'snakepit' | 'crystallization';

export interface ReplayRegressionCase {
  schema: typeof REPLAY_REGRESSION_SCHEMA;
  id: string;
  title: string;
  source_trace_id: string;
  targets: ReplayRegressionTarget[];
  cassette_path: string;
  command: {
    entrypoint: string;
    args?: string[];
    cwd?: string;
  };
  trace: ReplayTrace;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface ReplayRegressionResult {
  id: string;
  status: 'pass' | 'fail' | 'error';
  detail?: string;
}

export interface ReplayCorpusResult {
  target: ReplayRegressionTarget;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  results: ReplayRegressionResult[];
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function resolveInside(root: string, value: string, label: string): string {
  const resolved = resolve(root, value);
  if (!inside(root, resolved)) throw new Error(`${label} escapes project root: ${value}`);
  return resolved;
}

export function validateReplayRegressionCase(value: unknown): ReplayRegressionCase {
  const c = value as ReplayRegressionCase;
  if (!c || c.schema !== REPLAY_REGRESSION_SCHEMA) throw new Error('invalid replay regression schema');
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(c.id)) throw new Error(`invalid replay regression id: ${String(c.id)}`);
  if (!c.title || !c.source_trace_id) throw new Error(`replay regression ${c.id} is missing title or source_trace_id`);
  if (!Array.isArray(c.targets) || c.targets.length === 0) throw new Error(`replay regression ${c.id} has no targets`);
  if (!c.command?.entrypoint || !Array.isArray(c.trace?.stdout_lines)) {
    throw new Error(`replay regression ${c.id} has an invalid command or trace`);
  }
  return c;
}

export function loadReplayRegressionCases(
  corpusDir: string,
  target: ReplayRegressionTarget,
): ReplayRegressionCase[] {
  if (!existsSync(corpusDir)) return [];
  const cases: ReplayRegressionCase[] = [];
  for (const name of readdirSync(corpusDir).filter((file) => file.endsWith('.json')).sort()) {
    const parsed = validateReplayRegressionCase(JSON.parse(readFileSync(join(corpusDir, name), 'utf8')));
    if (parsed.targets.includes(target)) cases.push(parsed);
  }
  return cases;
}

export async function runReplayRegressionCase(
  testCase: ReplayRegressionCase,
  projectRoot: string,
  preloadPath: string,
): Promise<ReplayRegressionResult> {
  const c = validateReplayRegressionCase(testCase);
  const cassettePath = resolveInside(projectRoot, c.cassette_path, 'cassette_path');
  const entrypoint = resolveInside(projectRoot, c.command.entrypoint, 'command.entrypoint');
  const cwd = resolveInside(projectRoot, c.command.cwd ?? '.', 'command.cwd');
  if (!existsSync(cassettePath)) return { id: c.id, status: 'error', detail: `cassette not found: ${c.cassette_path}` };
  if (!existsSync(entrypoint)) return { id: c.id, status: 'error', detail: `entrypoint not found: ${c.command.entrypoint}` };
  loadCassette(cassettePath);

  const workspace = mkdtempSync(join(tmpdir(), `zouro-replay-${c.id}-`));
  try {
    const result = await evaluateReplay({
      trace: c.trace,
      command: { program: 'bun', args: [entrypoint, ...(c.command.args ?? [])], cwd },
      workspace,
      timeoutMs: 60_000,
      cassette: { path: cassettePath, preloadPath, source: `regression:${c.id}` },
    });
    return result.status === 'replay_pass'
      ? { id: c.id, status: 'pass' }
      : { id: c.id, status: 'fail', detail: JSON.stringify(result.diff) };
  } catch (error) {
    return { id: c.id, status: 'error', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runReplayCorpus(options: {
  corpusDir: string;
  target: ReplayRegressionTarget;
  projectRoot: string;
  preloadPath: string;
}): Promise<ReplayCorpusResult> {
  const cases = loadReplayRegressionCases(options.corpusDir, options.target);
  const results: ReplayRegressionResult[] = [];
  for (const testCase of cases) {
    results.push(await runReplayRegressionCase(testCase, options.projectRoot, options.preloadPath));
  }
  return {
    target: options.target,
    total: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    errors: results.filter((result) => result.status === 'error').length,
    results,
  };
}

export function writeReplayRegressionCase(
  outputDir: string,
  testCase: Omit<ReplayRegressionCase, 'schema' | 'created_at'>,
): string {
  const complete: ReplayRegressionCase = validateReplayRegressionCase({
    ...testCase,
    schema: REPLAY_REGRESSION_SCHEMA,
    created_at: new Date().toISOString(),
  });
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, `${complete.id}.json`);
  const tmp = `${output}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, output);
  return output;
}
