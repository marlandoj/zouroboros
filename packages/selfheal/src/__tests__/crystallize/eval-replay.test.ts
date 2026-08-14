/**
 * Replay eval coverage — drives FX-12 (egress refused), FX-13 (secret env
 * stripped), FX-14 (redactor stability), and FX-28 (mechanical_only fallback).
 *
 * FX-12 spawns a real bun child against the sandbox env to prove the
 * userspace proxy actually refuses egress. The other cases are pure-function
 * assertions on `buildSandboxEnv`, `redactLine`, and the trace-missing
 * fallback path.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSandboxEnv,
  evaluateReplay,
  evaluateReplayWithFallback,
  isSecretEnvName,
  redactLine,
  type ReplayTrace,
  SECRET_ENV_NAMES,
  SECRET_ENV_PREFIXES,
} from '../../crystallize/eval-replay.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

describe('crystallize/eval-replay — FX-13 secret env stripped', () => {
  test('all listed parent-env names are excluded from sandbox env', () => {
    const fx = FX('FX-13-replay-secret-stripped');
    const parentEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const k of fx.parent_env_keys as string[]) {
      parentEnv[k] = 'sensitive-value';
    }
    const env = buildSandboxEnv('/tmp/wsx', parentEnv);
    for (const k of fx.parent_env_keys as string[]) {
      expect(env[k]).toBeUndefined();
    }
    const allowed = new Set(fx.expected.allowed_keys as string[]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  test('isSecretEnvName covers all documented prefixes + explicit names', () => {
    for (const p of SECRET_ENV_PREFIXES) {
      expect(isSecretEnvName(`${p}EXAMPLE`)).toBe(true);
    }
    for (const n of SECRET_ENV_NAMES) {
      expect(isSecretEnvName(n)).toBe(true);
    }
    expect(isSecretEnvName('PATH')).toBe(false);
    expect(isSecretEnvName('LANG')).toBe(false);
  });
});

describe('crystallize/eval-replay — FX-14 redactor stability', () => {
  test('every documented case maps to its expected canonical form', () => {
    const fx = FX('FX-14-replay-redactor-stable');
    for (const c of fx.cases as Array<{ in: string; out: string }>) {
      expect(redactLine(c.in, fx.home)).toBe(c.out);
    }
  });

  test('redactor is idempotent (running twice yields same result)', () => {
    const fx = FX('FX-14-replay-redactor-stable');
    for (const c of fx.cases as Array<{ in: string; out: string }>) {
      const first = redactLine(c.in, fx.home);
      const second = redactLine(first, fx.home);
      expect(second).toBe(first);
    }
  });
});

describe('crystallize/eval-replay — FX-12 egress blocked', () => {
  test('spawned child cannot fetch through HTTPS_PROXY=http://127.0.0.1:0', async () => {
    const fx = FX('FX-12-replay-egress-blocked');
    const ws = mkdtempSync(join(tmpdir(), 'crystallize-ws-'));
    const scriptPath = join(ws, 'child.ts');
    writeFileSync(scriptPath, fx.child_script, 'utf8');

    const trace: ReplayTrace = {
      stdout_lines: ['caught: <ANY>'],
      exit_code: 7,
      files_written: ['child.ts'],
    };

    const result = await evaluateReplay({
      trace,
      command: { program: 'bun', args: [scriptPath] },
      workspace: ws,
      timeoutMs: 10_000,
    });

    // The expected trace claims exit_code=7; the sandbox may make fetch fail
    // with a different non-zero exit. Either way the diff must flag it.
    expect(result.status).toBe('replay_fail');
    expect(result.diff).toBeDefined();
    expect(result.diff!.observed_exit_code).not.toBe(0);
  }, 15_000);
});

describe('crystallize/eval-replay — FX-28 mechanical_only fallback', () => {
  test('missing trace fixture path is the signal callers use to fall back', () => {
    const fx = FX('FX-28-mechanical-only-no-trace');
    const tracePath = join(
      __dirname,
      '..',
      '..',
      '..',
      fx.input.trace_path,
    );
    expect(existsSync(tracePath)).toBe(false);
    expect(fx.expected.status).toBe('mechanical_only');
    expect(fx.expected.skip_replay).toBe(true);
  });

  test('evaluateReplayWithFallback(null) returns mechanical_only without spawning', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'crystallize-fallback-'));
    let spawnCalls = 0;
    const result = await evaluateReplayWithFallback(null, {
      command: { program: 'bun', args: ['--version'] },
      workspace: ws,
      timeoutMs: 5_000,
      spawner: (() => {
        spawnCalls += 1;
        throw new Error('spawner must not be invoked when trace is null');
      }) as never,
    });

    expect(spawnCalls).toBe(0);
    expect(result.status).toBe('mechanical_only');
    expect(result.events.length).toBe(1);
    expect(result.events[0].event_type).toBe('replay_eval');
    expect(result.events[0].payload.status).toBe('mechanical_only');
    expect(result.events[0].payload.reason).toBe('no_trace_available');
    expect(result.diff).toBeUndefined();
  });
});
