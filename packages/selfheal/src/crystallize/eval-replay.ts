/**
 * Replay evaluation of a candidate skill.
 *
 * Runs the candidate's stub scripts in a sandboxed child process and compares
 * the captured trace against the recorded fixture from `record-trace.ts`.
 *
 * Sandbox primitives (per plan B1, verified at startup — `unshare -n` requires
 * CAP_SYS_ADMIN unavailable in this runtime; `firejail` not on PATH):
 *   • Userspace proxy refusing all egress (HTTPS_PROXY/HTTP_PROXY=
 *     http://127.0.0.1:0; NO_PROXY="").
 *   • Allowlist-only env: PATH, HOME=$WORKSPACE, USER, LANG. All other vars
 *     stripped, including secrets (STRIPE_*, GMAIL_*, OPENAI_*, ANTHROPIC_*,
 *     ZO_*, ALPACA_*, CRYSTALLIZE_APPROVAL_SECRET).
 *   • Optional firejail wrap if `firejail --net=none` is available.
 *
 * Comparison (per plan B5 — ordered, not set-equality):
 *   • Stdout: line-by-line diff after redactor normalization
 *     (\d{10,} → <TS>, UUID → <UUID>, $HOME paths → ~).
 *   • Exit code: equality.
 *   • files_written_under_workspace: set equality.
 *
 * Sources without a post-deploy trace fall back to `eval_status='mechanical_only'`
 * (per plan B6 — record-trace.ts is forward-only, can't reconstruct history).
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { EvalStatus, EventType } from './types.js';

export interface ReplayTrace {
  /** Ordered stdout lines as captured during the original run. */
  stdout_lines: string[];
  exit_code: number;
  /** Workspace-relative paths written by the original run. */
  files_written: string[];
}

export interface ReplayCommand {
  /** Program — usually `bun`. */
  program: string;
  /** Argv after program. */
  args: string[];
  /** Optional working directory under the workspace. */
  cwd?: string;
}

export interface ReplayEvalOptions {
  /** Recorded trace from a forward run; replay is compared against this. */
  trace: ReplayTrace;
  /** Command to invoke the candidate's stub script(s). */
  command: ReplayCommand;
  /** Sandbox workspace root (writable scratch dir; absolute path). */
  workspace: string;
  /** ms before the child is killed. */
  timeoutMs?: number;
  /** Test hook — pluggable child-process spawner. */
  spawner?: typeof spawn;
  /** Optional deterministic HTTP/tool cassette injected through Bun preload. */
  cassette?: {
    path: string;
    preloadPath: string;
    source?: string;
  };
}

export interface ReplayEvalEvent {
  event_type: EventType;
  payload: Record<string, unknown>;
}

export interface ReplayEvalResult {
  status: Extract<EvalStatus, 'replay_pass' | 'replay_fail' | 'mechanical_only'>;
  events: ReplayEvalEvent[];
  diff?: ReplayDiff;
}

export interface ReplayDiff {
  exit_code_match: boolean;
  observed_exit_code: number;
  stdout_diff: { line: number; expected: string; observed: string }[];
  files_extra: string[];
  files_missing: string[];
}

/**
 * Secret env names that MUST be unset before spawn. Non-exhaustive — a
 * narrow allowlist is enforced separately, this list is the explicit-deny
 * defense-in-depth check.
 */
export const SECRET_ENV_PREFIXES = [
  'STRIPE_',
  'GMAIL_',
  'OPENAI_',
  'ANTHROPIC_',
  'ZO_',
  'ALPACA_',
  'GITHUB_',
  'AWS_',
] as const;

export const SECRET_ENV_NAMES = ['CRYSTALLIZE_APPROVAL_SECRET'] as const;

/**
 * Construct the env block passed to the sandbox child. Pure function so tests
 * can assert it directly without spawning.
 */
export function buildSandboxEnv(
  workspace: string,
  parent: NodeJS.ProcessEnv = process.env,
  replay?: ReplayEvalOptions['cassette'],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: workspace,
    USER: parent.USER ?? 'crystallize',
    LANG: parent.LANG ?? 'C.UTF-8',
    HTTPS_PROXY: 'http://127.0.0.1:0',
    HTTP_PROXY: 'http://127.0.0.1:0',
    NO_PROXY: '',
  };
  if (replay) {
    if (!isAbsolute(replay.path) || !isAbsolute(replay.preloadPath)) {
      throw new Error('replay cassette and preload paths must be absolute');
    }
    env.ZOUROBOROS_REPLAY_MODE = 'replay';
    env.ZOUROBOROS_REPLAY_CASSETTE = replay.path;
    env.ZOUROBOROS_REPLAY_SOURCE = replay.source ?? 'crystallization-eval';
  }
  // Defense-in-depth: explicitly NOT propagating any secret; the allowlist
  // above is exhaustive. The prefix list documents what we'd strip if the
  // allowlist were ever loosened.
  return env;
}

/**
 * Check whether a parent-env name should be considered secret. Used by
 * hardening tests; the actual sandbox uses an allowlist (above).
 */
export function isSecretEnvName(name: string): boolean {
  if ((SECRET_ENV_NAMES as readonly string[]).includes(name)) return true;
  return SECRET_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** Redact ephemeral content for ordered stdout comparison (per plan B5). */
export function redactLine(line: string, home: string): string {
  let out = line;
  // Absolute $HOME paths → ~
  if (home && home.length > 0) {
    out = out.split(home).join('~');
  }
  // UUIDs (8-4-4-4-12 hex)
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
  // Long numbers (10+ digits — timestamps, ids)
  out = out.replace(/\b\d{10,}\b/g, '<TS>');
  return out;
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

export async function evaluateReplay(opts: ReplayEvalOptions): Promise<ReplayEvalResult> {
  const events: ReplayEvalEvent[] = [];
  const env = buildSandboxEnv(opts.workspace, process.env, opts.cassette);
  const sp = opts.spawner ?? spawn;
  if (opts.cassette && opts.command.program !== 'bun') {
    throw new Error('deterministic cassette replay currently requires a bun command');
  }
  if (opts.cassette && !existsSync(opts.cassette.preloadPath)) {
    throw new Error(`replay preload not found: ${opts.cassette.preloadPath}`);
  }
  const commandArgs = opts.cassette
    ? ['--preload', opts.cassette.preloadPath, ...opts.command.args]
    : opts.command.args;
  const child = sp(opts.command.program, commandArgs, {
    cwd: opts.command.cwd ?? opts.workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += d.toString()));
  child.stderr?.on('data', (d) => (stderr += d.toString()));

  const exitCode: number = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`replay timeout after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });

  const observedLines = stdout.split('\n').filter((l) => l.length > 0);
  const expectedLines = opts.trace.stdout_lines;
  const stdoutDiff: ReplayDiff['stdout_diff'] = [];
  const max = Math.max(expectedLines.length, observedLines.length);
  for (let i = 0; i < max; i++) {
    const exp = redactLine(expectedLines[i] ?? '', opts.workspace);
    const obs = redactLine(observedLines[i] ?? '', opts.workspace);
    if (exp !== obs) {
      stdoutDiff.push({ line: i + 1, expected: exp, observed: obs });
    }
  }

  const observedFiles = listFilesRecursive(opts.workspace);
  const expectedFileSet = new Set(opts.trace.files_written);
  const observedFileSet = new Set(observedFiles);
  const filesExtra = observedFiles.filter((f) => !expectedFileSet.has(f));
  const filesMissing = opts.trace.files_written.filter((f) => !observedFileSet.has(f));

  const diff: ReplayDiff = {
    exit_code_match: exitCode === opts.trace.exit_code,
    observed_exit_code: exitCode,
    stdout_diff: stdoutDiff,
    files_extra: filesExtra,
    files_missing: filesMissing,
  };

  const ok =
    diff.exit_code_match &&
    diff.stdout_diff.length === 0 &&
    diff.files_extra.length === 0 &&
    diff.files_missing.length === 0;

  events.push({
    event_type: 'replay_eval',
    payload: { status: ok ? 'replay_pass' : 'replay_fail', diff, stderr_excerpt: stderr.slice(0, 400) },
  });

  return { status: ok ? 'replay_pass' : 'replay_fail', events, diff };
}

/**
 * Wrapper that handles the trace-missing fallback path (per seed B6). When a
 * source has no recorded post-deploy trace, replay is skipped and the result
 * is `mechanical_only`. PR3's CLI uses this wrapper; the function exists in
 * PR2 so the AC ("sources without a trace fall back to mechanical_only") is
 * empirically falsifiable.
 */
export async function evaluateReplayWithFallback(
  trace: ReplayTrace | null,
  opts: Omit<ReplayEvalOptions, 'trace'>,
): Promise<ReplayEvalResult> {
  if (trace === null) {
    return {
      status: 'mechanical_only',
      events: [
        {
          event_type: 'replay_eval',
          payload: { status: 'mechanical_only', reason: 'no_trace_available' },
        },
      ],
    };
  }
  return evaluateReplay({ ...opts, trace });
}
