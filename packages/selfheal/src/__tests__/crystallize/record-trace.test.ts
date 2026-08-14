/**
 * Record-trace coverage — proves the recorder captures stdout lines, exit
 * code, and workspace-relative files written under the workspace, and round-
 * trips a fixture cleanly through `writeTraceFixture`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordTrace,
  writeTraceFixture,
} from '../../crystallize/record-trace.js';

describe('crystallize/record-trace', () => {
  test('captures stdout lines, exit code, and new workspace files', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'crystallize-rec-'));
    const script = `
      import { writeFileSync } from 'fs';
      import { join } from 'path';
      console.log('line one');
      console.log('line two');
      writeFileSync(join('${ws.replace(/\\/g, '\\\\')}', 'out.txt'), 'data');
      process.exit(0);
    `;
    const scriptPath = join(ws, 'producer.ts');
    writeFileSync(scriptPath, script, 'utf8');

    const trace = await recordTrace({
      command: { program: 'bun', args: [scriptPath] },
      workspace: ws,
      timeoutMs: 10_000,
    });

    expect(trace.exit_code).toBe(0);
    expect(trace.stdout_lines).toContain('line one');
    expect(trace.stdout_lines).toContain('line two');
    expect(trace.files_written).toContain('out.txt');
    // producer.ts existed before invocation (we wrote it ourselves) — the
    // before/after diff must NOT report it as written.
    expect(trace.files_written).not.toContain('producer.ts');
  }, 15_000);

  test('writeTraceFixture round-trips JSON exactly', () => {
    const ws = mkdtempSync(join(tmpdir(), 'crystallize-rec-rt-'));
    const trace = {
      stdout_lines: ['a', 'b', 'c'],
      exit_code: 0,
      files_written: ['out/x.txt'],
    };
    const path = join(ws, 'nested', 'trace.json');
    writeTraceFixture(path, trace);
    const round = JSON.parse(readFileSync(path, 'utf8'));
    expect(round).toEqual(trace);
  });

  test('non-zero child exit is captured (does not throw)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'crystallize-rec-fail-'));
    const scriptPath = join(ws, 'fail.ts');
    writeFileSync(scriptPath, 'process.exit(42);', 'utf8');

    const trace = await recordTrace({
      command: { program: 'bun', args: [scriptPath] },
      workspace: ws,
      timeoutMs: 10_000,
    });
    expect(trace.exit_code).toBe(42);
  }, 15_000);
});
