import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  storeSwarmTaskEval,
  storeToolReflection,
  classifyFailure,
  getToolReflections,
} from '../evolve/tool-reflections.js';

const TEST_DB = join(tmpdir(), `tool-evals-test-${Date.now()}.db`);

beforeEach(() => {
  process.env.ZOUROBOROS_MEMORY_DB = TEST_DB;
  execSync(`sqlite3 "${TEST_DB}" "
    CREATE TABLE IF NOT EXISTS swarm_task_evals (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      tool_args TEXT,
      outcome TEXT CHECK(outcome IN ('success','failure','partial')),
      precision_score REAL,
      recall_score REAL,
      argument_accuracy REAL,
      error_type TEXT,
      error_message TEXT,
      duration_ms INTEGER,
      persona TEXT,
      session_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS tool_reflections (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      failure_class TEXT,
      heuristic TEXT,
      evidence TEXT,
      applied_count INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  "`);
});

afterEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  delete process.env.ZOUROBOROS_MEMORY_DB;
});

describe('classifyFailure', () => {
  test('classifies timeout errors', () => {
    expect(classifyFailure('request timed out after 30s')).toBe('timeout');
    expect(classifyFailure('executor timeout')).toBe('timeout');
  });

  test('classifies not_found errors', () => {
    expect(classifyFailure('task not found in registry')).toBe('not_found');
    expect(classifyFailure('404 resource does not exist')).toBe('not_found');
  });

  test('classifies permission errors', () => {
    expect(classifyFailure('permission denied for operation')).toBe('permission_denied');
    expect(classifyFailure('unauthorized access 403')).toBe('permission_denied');
  });

  test('classifies api errors', () => {
    expect(classifyFailure('api returned 503 service unavailable')).toBe('api_error');
    expect(classifyFailure('rate limit exceeded')).toBe('api_error');
  });

  test('classifies schema mismatches', () => {
    expect(classifyFailure('invalid param schema')).toBe('schema_mismatch');
  });

  test('falls back to other', () => {
    expect(classifyFailure('something completely unexpected happened')).toBe('other');
  });
});

describe('storeSwarmTaskEval', () => {
  test('writes a success record', () => {
    storeSwarmTaskEval({ toolName: 'test-task', outcome: 'success', durationMs: 100, persona: 'alaric' });
    const row = execSync(`sqlite3 "${TEST_DB}" "SELECT tool_name,outcome,duration_ms,persona FROM swarm_task_evals LIMIT 1"`).toString().trim();
    expect(row).toBe('test-task|success|100|alaric');
  });

  test('writes a failure record with error fields', () => {
    storeSwarmTaskEval({ toolName: 'failing-task', outcome: 'failure', durationMs: 500, errorType: 'timeout', errorMessage: 'timed out', persona: 'mimir' });
    const row = execSync(`sqlite3 "${TEST_DB}" "SELECT outcome,error_type,error_message FROM swarm_task_evals LIMIT 1"`).toString().trim();
    expect(row).toBe('failure|timeout|timed out');
  });

  test('no-ops when DB does not exist', () => {
    process.env.ZOUROBOROS_MEMORY_DB = '/nonexistent/path/db.sqlite';
    expect(() => storeSwarmTaskEval({ toolName: 'x', outcome: 'success', durationMs: 1 })).not.toThrow();
  });

  test('stores multiple records independently', () => {
    storeSwarmTaskEval({ toolName: 'task-a', outcome: 'success', durationMs: 50 });
    storeSwarmTaskEval({ toolName: 'task-b', outcome: 'failure', durationMs: 200 });
    const count = execSync(`sqlite3 "${TEST_DB}" "SELECT COUNT(*) FROM swarm_task_evals"`).toString().trim();
    expect(count).toBe('2');
  });
});

describe('storeToolReflection + getToolReflections round-trip', () => {
  test('stores and retrieves a reflection', () => {
    storeToolReflection('my-tool', 'timeout', 'Add retry logic for long-running tasks', 'timed out at 30s');
    const refs = getToolReflections('my-tool');
    expect(refs.length).toBe(1);
    expect(refs[0].failure_class).toBe('timeout');
    expect(refs[0].heuristic).toContain('retry');
  });

  test('increments applied_count on duplicate heuristic', () => {
    storeToolReflection('my-tool', 'timeout', 'same heuristic');
    storeToolReflection('my-tool', 'timeout', 'same heuristic');
    const refs = getToolReflections('my-tool');
    expect(refs[0].applied_count).toBe(2);
  });
});
