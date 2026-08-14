#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { recordTrace, writeTraceFixture } from '../crystallize/record-trace.js';
import { evaluateReplay, type ReplayTrace } from '../crystallize/eval-replay.js';
import { loadCassette } from '../replay/cassette.js';
import { writeReplayRegressionCase, type ReplayRegressionTarget } from '../replay/regression.js';

function usage(): never {
  console.log(`Usage:
  zouroboros-replay record --cassette <path> --trace <path> --trace-id <id> -- <script> [args...]
  zouroboros-replay replay --cassette <path> --trace <path> -- <script> [args...]
  zouroboros-replay export --id <id> --title <title> --cassette <path> --trace <path> --entrypoint <path> [--targets zourobench,snakepit]

Record mode permits real network access but redacts persisted secrets. Replay mode strips secrets and refuses network egress.`);
  process.exit(0);
}

function splitCommand(args: string[]): { options: string[]; command: string[] } {
  const marker = args.indexOf('--');
  return marker === -1
    ? { options: args, command: [] }
    : { options: args.slice(0, marker), command: args.slice(marker + 1) };
}

function projectRoot(): string {
  return resolve(process.env.ZOUROBOROS_PROJECT_ROOT ?? join(import.meta.dir, '..', '..', '..'));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function recordOrReplay(mode: 'record' | 'replay', args: string[]): Promise<number> {
  const { options, command } = splitCommand(args);
  const { values } = parseArgs({
    args: options,
    options: {
      cassette: { type: 'string' },
      trace: { type: 'string' },
      'trace-id': { type: 'string' },
      source: { type: 'string', default: 'replay-cli' },
    },
    strict: true,
  });
  if (!values.cassette || !values.trace || command.length === 0) {
    throw new Error(`${mode} requires --cassette, --trace, and a command after --`);
  }
  if (mode === 'record' && !values['trace-id']) throw new Error('record requires --trace-id');

  const root = projectRoot();
  const cassette = resolve(values.cassette);
  const tracePath = resolve(values.trace);
  const entrypoint = resolve(root, command[0]);
  if (!inside(root, entrypoint) || !existsSync(entrypoint)) throw new Error(`entrypoint must exist under project root: ${command[0]}`);
  const preload = join(root, 'packages', 'selfheal', 'src', 'replay', 'preload.ts');

  if (mode === 'record') {
    const trace = await recordTrace({
      command: {
        program: 'bun',
        args: ['--preload', preload, entrypoint, ...command.slice(1)],
        cwd: root,
        env: {
          ZOUROBOROS_REPLAY_MODE: 'record',
          ZOUROBOROS_REPLAY_CASSETTE: cassette,
          ZOUROBOROS_REPLAY_SOURCE: values.source,
          ZO_TRACE_ID: values['trace-id'],
        },
      },
      workspace: root,
      timeoutMs: 120_000,
    });
    writeTraceFixture(tracePath, trace);
    console.log(JSON.stringify({ status: 'recorded', cassette, trace: tracePath, interactions: loadCassette(cassette).interactions.length }));
    return trace.exit_code;
  }

  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as ReplayTrace;
  const scratch = resolve(process.env.ZOUROBOROS_REPLAY_WORKSPACE ?? join(process.env.HOME ?? '/tmp', '.zouroboros', 'replay-workspace'));
  const result = await evaluateReplay({
    trace,
    command: { program: 'bun', args: [entrypoint, ...command.slice(1)], cwd: root },
    workspace: scratch,
    cassette: { path: cassette, preloadPath: preload, source: values.source },
  });
  console.log(JSON.stringify(result));
  return result.status === 'replay_pass' ? 0 : 1;
}

function exportCase(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
      title: { type: 'string' },
      cassette: { type: 'string' },
      trace: { type: 'string' },
      entrypoint: { type: 'string' },
      targets: { type: 'string', default: 'zourobench,snakepit' },
      'args-json': { type: 'string', default: '[]' },
      'crystallization-slug': { type: 'string' },
      'candidate-entrypoint': { type: 'string' },
    },
    strict: true,
  });
  if (!values.id || !values.title || !values.cassette || !values.trace || !values.entrypoint) {
    throw new Error('export requires --id, --title, --cassette, --trace, and --entrypoint');
  }
  const root = projectRoot();
  const cassette = resolve(values.cassette);
  const tracePath = resolve(values.trace);
  const entrypoint = resolve(root, values.entrypoint);
  if (!inside(root, cassette) || !inside(root, tracePath) || !inside(root, entrypoint)) {
    throw new Error('export inputs must be stored under the project root');
  }
  const loaded = loadCassette(cassette);
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as ReplayTrace;
  const targets = values.targets.split(',').map((target) => target.trim()) as ReplayRegressionTarget[];
  if (targets.some((target) => !['zourobench', 'snakepit', 'crystallization'].includes(target))) {
    throw new Error(`invalid replay targets: ${values.targets}`);
  }
  const commandArgs = JSON.parse(values['args-json']) as unknown;
  if (!Array.isArray(commandArgs) || commandArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('--args-json must be a JSON string array');
  }
  const output = writeReplayRegressionCase(join(root, 'Seeds', 'zouroboros', 'replay'), {
    id: values.id,
    title: values.title,
    source_trace_id: loaded.trace_id,
    targets,
    cassette_path: relative(root, cassette),
    command: { entrypoint: relative(root, entrypoint), args: commandArgs as string[] },
    trace,
    metadata: values['crystallization-slug'] || values['candidate-entrypoint']
      ? {
          ...(values['crystallization-slug']
            ? { crystallization_slug: values['crystallization-slug'] }
            : {}),
          ...(values['candidate-entrypoint']
            ? { candidate_entrypoint: values['candidate-entrypoint'] }
            : {}),
        }
      : undefined,
  });
  console.log(JSON.stringify({ status: 'exported', output }));
  return 0;
}

const [command, ...args] = Bun.argv.slice(2);
if (!command || command === '--help' || command === '-h') usage();

try {
  const code = command === 'record' || command === 'replay'
    ? await recordOrReplay(command, args)
    : command === 'export'
      ? exportCase(args)
      : 2;
  if (code === 2) console.error(`unknown command: ${command}`);
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
