/**
 * Forward-only trace recorder.
 *
 * Per plan B6: this module instruments a *fresh* run of a procedure / episode
 * / skill_execution and writes a `ReplayTrace` JSON to disk. It cannot
 * reconstruct historical traces — sources without a post-deploy run fall back
 * to `eval_status='mechanical_only'` until they execute again.
 *
 * The recorder is a thin shell around `child_process.spawn`:
 *   • Captures stdout line-by-line (no buffering loss across newlines).
 *   • Snapshots files written under the workspace via before/after listings.
 *   • Records exit code.
 *
 * The CLI in PR3 wires this to the actual procedure/skill_execution registry;
 * here we keep the interface narrow so PR2 tests can drive it directly.
 */

import { spawn, SpawnOptions } from 'child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { mkdirSync } from 'fs';
import { ReplayTrace } from './eval-replay.js';

export interface RecordTraceCommand {
  program: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RecordTraceOptions {
  command: RecordTraceCommand;
  /** Workspace root we monitor for `files_written`. */
  workspace: string;
  timeoutMs?: number;
  spawner?: typeof spawn;
}

export async function recordTrace(opts: RecordTraceOptions): Promise<ReplayTrace> {
  const before = new Set(listFilesRecursive(opts.workspace));
  const sp = opts.spawner ?? spawn;
  const spawnOpts: SpawnOptions = {
    cwd: opts.command.cwd ?? opts.workspace,
    env: { ...process.env, ...(opts.command.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const child = sp(opts.command.program, opts.command.args, spawnOpts);

  let stdout = '';
  child.stdout?.on('data', (d) => (stdout += d.toString()));
  // stderr is captured but not part of the trace contract.
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d.toString()));

  const exit_code: number = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`record-trace timeout after ${opts.timeoutMs ?? 60_000}ms`));
    }, opts.timeoutMs ?? 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });

  const after = listFilesRecursive(opts.workspace);
  const stdout_lines = stdout.split('\n').filter((l) => l.length > 0);
  const files_written = after.filter((f) => !before.has(f)).sort();

  // stderr is intentionally dropped from the recorded trace — replay parity
  // is asserted on stdout / exit / written-files only (per plan B5).
  void stderr;

  return { stdout_lines, exit_code, files_written };
}

export function writeTraceFixture(path: string, trace: ReplayTrace): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(trace, null, 2) + '\n', 'utf8');
}

function listFilesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  }
  return out.sort();
}
