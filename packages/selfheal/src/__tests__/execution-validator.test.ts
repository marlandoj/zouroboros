import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateToolFit,
  storeValidation,
  getValidationStats,
  deriveDefaultInputs,
} from '../evolve/execution-validator.js';

const TEST_DB = join(tmpdir(), `exec-validator-test-${Date.now()}.db`);

beforeEach(() => {
  process.env.ZOUROBOROS_MEMORY_DB = TEST_DB;
  execSync(`sqlite3 "${TEST_DB}" "
    CREATE TABLE IF NOT EXISTS tool_validations (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      role_id TEXT,
      task_id TEXT,
      validation_outcome TEXT CHECK(validation_outcome IN ('pass','fail_warning','fail_fatal')),
      missing_keys TEXT,
      type_mismatches TEXT,
      score REAL,
      persona TEXT,
      session_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  "`);
});

afterEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  delete process.env.ZOUROBOROS_MEMORY_DB;
});

describe('validateToolFit', () => {
  test('passes when all required keys present and types match', () => {
    const result = validateToolFit(
      'claude-code',
      { task_spec: 'Build login form', codebase_context: 'react app' },
      { task_spec: 'string', codebase_context: 'string' },
    );
    expect(result.outcome).toBe('pass');
    expect(result.score).toBe(1.0);
    expect(result.missingKeys).toHaveLength(0);
    expect(result.typeMismatches).toHaveLength(0);
  });

  test('warns on missing keys', () => {
    const result = validateToolFit(
      'claude-code',
      { task_spec: 'Build login form' },
      { task_spec: 'string', codebase_context: 'string' },
    );
    expect(result.outcome).toBe('fail_warning');
    expect(result.score).toBe(0.5);
    expect(result.missingKeys).toEqual(['codebase_context']);
  });

  test('warns on type mismatches', () => {
    const result = validateToolFit(
      'claude-code',
      { task_spec: 42, codebase_context: 'react app' },
      { task_spec: 'string', codebase_context: 'string' },
    );
    expect(result.outcome).toBe('fail_warning');
    expect(result.typeMismatches).toEqual([
      { key: 'task_spec', expected: 'string', actual: 'number' },
    ]);
  });

  test('elevates to fatal when fatal:true', () => {
    const result = validateToolFit(
      'claude-code',
      {},
      { task_spec: 'string' },
      { fatal: true },
    );
    expect(result.outcome).toBe('fail_fatal');
  });

  test('skips when no schema declared', () => {
    const result = validateToolFit('claude-code', { anything: 'goes' }, undefined);
    expect(result.outcome).toBe('pass');
    expect(result.score).toBe(1.0);
  });

  test('skips when empty schema', () => {
    const result = validateToolFit('claude-code', { x: 1 }, {});
    expect(result.outcome).toBe('pass');
  });

  test('treats "any" as wildcard', () => {
    const result = validateToolFit(
      'tool',
      { x: { nested: true } },
      { x: 'any' },
    );
    expect(result.outcome).toBe('pass');
  });

  test('matches array type', () => {
    const result = validateToolFit(
      'tool',
      { items: [1, 2, 3] },
      { items: 'array' },
    );
    expect(result.outcome).toBe('pass');
  });

  test('partial match yields proportional score', () => {
    const result = validateToolFit(
      'tool',
      { a: 'x', b: 'y' },
      { a: 'string', b: 'string', c: 'string', d: 'string' },
    );
    expect(result.score).toBe(0.5);
    expect(result.missingKeys).toEqual(['c', 'd']);
  });
});

describe('storeValidation + getValidationStats', () => {
  test('persists pass and warning records', () => {
    storeValidation({
      toolName: 'claude-code',
      roleId: 'frontend-engineer',
      taskId: 't1',
      outcome: 'pass',
      score: 1.0,
      missingKeys: [],
      typeMismatches: [],
    });
    storeValidation({
      toolName: 'claude-code',
      roleId: 'frontend-engineer',
      taskId: 't2',
      outcome: 'fail_warning',
      score: 0.5,
      missingKeys: ['design_brief'],
      typeMismatches: [],
    });

    const stats = getValidationStats({ toolName: 'claude-code' });
    expect(stats.total).toBe(2);
    expect(stats.pass).toBe(1);
    expect(stats.warning).toBe(1);
    expect(stats.passRate).toBe(0.5);
  });

  test('returns zero stats when no records', () => {
    const stats = getValidationStats({ toolName: 'nonexistent-tool' });
    expect(stats.total).toBe(0);
    expect(stats.passRate).toBe(0);
  });

  test('auto-creates tool_validations table when migration has not run', () => {
    const freshDb = join(tmpdir(), `exec-validator-fresh-${Date.now()}.db`);
    process.env.ZOUROBOROS_MEMORY_DB = freshDb;
    execSync(`sqlite3 "${freshDb}" "SELECT 1"`);

    storeValidation({
      toolName: 'claude-code',
      outcome: 'pass',
      score: 1.0,
      missingKeys: [],
      typeMismatches: [],
    });

    const tableCheck = execSync(
      `sqlite3 "${freshDb}" "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_validations'"`,
      { encoding: 'utf-8' }
    ).trim();
    expect(tableCheck).toBe('tool_validations');

    const stats = getValidationStats({ toolName: 'claude-code' });
    expect(stats.total).toBe(1);

    if (existsSync(freshDb)) unlinkSync(freshDb);
  });
});

describe('deriveDefaultInputs', () => {
  test('extracts task_spec from prose', () => {
    const inputs = deriveDefaultInputs('Build a login form');
    expect(inputs.task_spec).toBe('Build a login form');
  });

  test('attaches RAG context as codebase_context', () => {
    const inputs = deriveDefaultInputs('Refactor auth', {
      ragContext: 'auth module uses JWT',
    });
    expect(inputs.codebase_context).toBe('auth module uses JWT');
  });

  test('detects design intent from prose', () => {
    const inputs = deriveDefaultInputs('Design the dashboard UI');
    expect(inputs.design_brief).toBeDefined();
  });

  test('does not over-attach when prose is plain', () => {
    const inputs = deriveDefaultInputs('Run the linter');
    expect(inputs.design_brief).toBeUndefined();
  });
});
