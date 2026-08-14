import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PlanGateLedger } from '../ledger.js';
import type { FindingType, LedgerRecord } from '../types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function findingCounts(): Record<FindingType, number> {
  return {
    substantive: 0, infrastructure: 0, formatting: 0, out_of_scope: 0,
    provider_failure: 0, abstention: 0, malformed_output: 0,
  };
}

function record(id: string): LedgerRecord {
  return {
    record_id: id,
    artifact_sha256: 'a'.repeat(64),
    revision: 1,
    gate_run_id: `gate-${id}`,
    decision: 'passed',
    policy_mode: 'mandatory',
    timestamp: '2026-07-17T20:00:00.000Z',
    provider_health_summary: { test: 'healthy' },
    call_count: 1,
    cost_usd: 0.01,
    finding_counts: findingCounts(),
  };
}

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-gate-ledger-'));
  dirs.push(dir);
  return join(dir, 'audit.jsonl');
}

describe('PlanGateLedger', () => {
  test('writes a restricted, verifiable hash chain', () => {
    const path = ledgerPath();
    const ledger = new PlanGateLedger({ ledgerPath: path });
    ledger.append(record('one'));
    ledger.append(record('two'));
    expect(ledger.readAll()).toHaveLength(2);
    expect(ledger.verify()).toEqual({ valid: true, record_count: 2 });
    const mode = Bun.file(path).stat().then((stat) => stat.mode & 0o777);
    return expect(mode).resolves.toBe(0o600);
  });

  test('fails closed on malformed or tampered records', () => {
    const path = ledgerPath();
    const ledger = new PlanGateLedger({ ledgerPath: path });
    ledger.append(record('one'));
    appendFileSync(path, '{broken json\n');
    expect(ledger.verify().valid).toBe(false);

    const [line] = readFileSync(path, 'utf8').split('\n');
    const parsed = JSON.parse(line);
    parsed.decision = 'rejected';
    writeFileSync(path, `${JSON.stringify(parsed)}\n`);
    chmodSync(path, 0o600);
    expect(ledger.verify().valid).toBe(false);
  });

  test('preserves the chain anchor across rotation', () => {
    const path = ledgerPath();
    const ledger = new PlanGateLedger({ ledgerPath: path, maxSizeBytes: 1 });
    ledger.append(record('one'));
    ledger.append(record('two'));
    expect(readdirSync(join(path, '..')).some((name) => name.startsWith('audit.jsonl.'))).toBe(true);
    expect(ledger.verify()).toEqual({ valid: true, record_count: 1 });
  });

  test('serializes concurrent writers across processes', async () => {
    const path = ledgerPath();
    const worker = resolve(import.meta.dir, '../__fixtures__/ledger-worker.ts');
    const children = Array.from({ length: 4 }, (_, index) => Bun.spawn(
      ['bun', worker, path, `worker-${index}`, '5'],
      { stdout: 'pipe', stderr: 'pipe' },
    ));
    const exitCodes = await Promise.all(children.map((child) => child.exited));
    expect(exitCodes).toEqual([0, 0, 0, 0]);
    const ledger = new PlanGateLedger({ ledgerPath: path });
    expect(ledger.readAll()).toHaveLength(20);
    expect(ledger.verify()).toEqual({ valid: true, record_count: 20 });
  });

  test('prunes archives older than the configured retention window', () => {
    const path = ledgerPath();
    const oldArchive = `${path}.2026-01-01T00-00-00-000Z`;
    writeFileSync(oldArchive, '{}\n');
    const old = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(oldArchive, old, old);
    const ledger = new PlanGateLedger({ ledgerPath: path, retentionDays: 1 });
    ledger.pruneArchives();
    expect(readdirSync(join(path, '..'))).not.toContain('audit.jsonl.2026-01-01T00-00-00-000Z');
  });
});
