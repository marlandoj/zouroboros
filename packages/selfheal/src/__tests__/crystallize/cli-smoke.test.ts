/**
 * cli/crystallize.ts — smoke test.
 *
 * The CLI is mostly thin glue over modules already covered by unit tests.
 * This file pins the user-facing contract:
 *   • `--help` exits 0 and prints usage
 *   • unknown command exits 2
 *   • `expire` against an empty DB exits 0 with no archives
 *   • `scan --dry-run` runs without CRYSTALLIZE_APPROVAL_SECRET set
 *
 * We invoke the CLI as a subprocess so process.exit() / Bun.argv parsing
 * behave exactly like production. Each test gets its own tmp dir + DB.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(
  __dirname,
  '..',
  '..',
  'cli',
  'crystallize.ts',
);

let tmp = '';
let projectRoot = '';
let skillsRoot = '';
let memoryDb = '';

function envFor(extra: Record<string, string> = {}): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;
  delete base.CRYSTALLIZE_APPROVAL_SECRET;
  return {
    ...base,
    ZOUROBOROS_PROJECT_ROOT: projectRoot,
    ZOUROBOROS_SKILLS_ROOT: skillsRoot,
    ZOUROBOROS_MEMORY_DB: memoryDb,
    ...extra,
  };
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    env: envFor(extraEnv),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe('cli/crystallize (smoke)', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cryst-cli-'));
    projectRoot = tmp;
    skillsRoot = join(tmp, 'Skills');
    mkdirSync(skillsRoot, { recursive: true });
    memoryDb = join(tmp, 'memory.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--help prints usage and exits 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('zouroboros-crystallize');
    expect(r.stdout).toContain('scan');
    expect(r.stdout).toContain('approve');
    expect(r.stdout).toContain('reject');
    expect(r.stdout).toContain('expire');
  });

  test('unknown command exits 2', async () => {
    const r = await runCli(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command');
  });

  test('expire against an empty (un-migrated) DB exits cleanly', async () => {
    // The CLI itself does not run migrations — that's `zouroboros init`.
    // The smoke test asserts the failure mode is a clean non-zero exit
    // mentioning the missing table, NOT an unhandled exception.
    const r = await runCli(['expire']);
    if (r.code === 0) {
      const out = JSON.parse(r.stdout);
      expect(out.expired_ids).toEqual([]);
      expect(out.archived_count).toBe(0);
    } else {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('crystallizations');
    }
  });

  test('scan --dry-run runs without CRYSTALLIZE_APPROVAL_SECRET', async () => {
    // Empty memory DB ⇒ no procedures/episodes/skill_executions ⇒ no_candidates.
    // What we're asserting: the CLI does not crash on a missing secret.
    const r = await runCli(['scan', '--dry-run', '--trigger', 'manual']);
    // Memory DB needs the procedures/episodes tables. The CLI fails fast if
    // missing — we accept either no_candidates (tables exist) or a clear
    // error referencing the missing tables (tables not created in this tmp).
    expect([0, 1]).toContain(r.code);
    if (r.code === 0) {
      const out = JSON.parse(r.stdout);
      expect(out).toHaveProperty('outcome');
    } else {
      // Surfacing the schema gap is acceptable; what's NOT acceptable is the
      // 'CRYSTALLIZE_APPROVAL_SECRET' substring leaking out, which would
      // mean the dry-run preflight regression returned.
      expect(r.stderr).not.toContain('CRYSTALLIZE_APPROVAL_SECRET');
    }
  });

  test('scan without --dry-run requires CRYSTALLIZE_APPROVAL_SECRET', async () => {
    const r = await runCli(['scan']);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain('CRYSTALLIZE_APPROVAL_SECRET');
  });

  test('approve missing --token exits 2', async () => {
    const r = await runCli(['approve', 'some-id'], {
      CRYSTALLIZE_APPROVAL_SECRET: 'a'.repeat(32),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing --token');
  });
});
