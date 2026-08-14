/**
 * Execution Validator — M10 W3 t7
 *
 * Schema-fit pre-check (GRETEL-pattern proxy) that runs BEFORE tool dispatch.
 *
 * Given a role's declared `inputs` schema (from the Role Registry SOP contract)
 * and the actual `task.inputs` payload, check that required keys are present
 * and basic types match. Persists every check to `tool_validations` so
 * fit-rate can be tracked over time.
 *
 * Note: this is a static schema-fit proxy, not a sandboxed-execution guard.
 * Tool calls still run normally; this just observes mismatch ahead of time
 * and surfaces a soft warning. Default outcome is non-blocking.
 *
 * Storage: tool_validations table in shared-facts.db (migration 015).
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getMemoryDbPath } from 'zouroboros-core';

function getDB(): string { return getMemoryDbPath(); }

export type ValidationOutcome = 'pass' | 'fail_warning' | 'fail_fatal';

export interface ValidationResult {
  outcome: ValidationOutcome;
  score: number;
  missingKeys: string[];
  typeMismatches: Array<{ key: string; expected: string; actual: string }>;
  message: string;
}

export interface ValidationRecord {
  toolName: string;
  roleId?: string;
  taskId?: string;
  outcome: ValidationOutcome;
  score: number;
  missingKeys: string[];
  typeMismatches: Array<{ key: string; expected: string; actual: string }>;
  persona?: string;
  sessionId?: string;
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function schemaTypeMatches(expected: string, actualType: string): boolean {
  const e = expected.toLowerCase().trim();
  if (!e || e === 'any' || e === 'unknown') return true;
  if (e === actualType) return true;
  if (e === 'object' && actualType === 'object') return true;
  if (e === 'array' && actualType === 'array') return true;
  if (e === 'number' && actualType === 'number') return true;
  if (e === 'string' && actualType === 'string') return true;
  if (e === 'boolean' && actualType === 'boolean') return true;
  return false;
}

/**
 * Validate that `actualInputs` satisfies `schema` (a key→type map from role.inputs).
 * Returns a ValidationResult with score in [0,1] and missing/mismatch detail.
 *
 * Default outcome policy:
 *   - All keys present + types match  → pass (score 1.0)
 *   - At least one missing/mismatch   → fail_warning (score < 1.0)
 *   - Caller can elevate to fail_fatal via flag
 */
export function validateToolFit(
  toolName: string,
  actualInputs: Record<string, unknown> | undefined,
  schema: Record<string, unknown> | undefined,
  options: { fatal?: boolean } = {}
): ValidationResult {
  const missingKeys: string[] = [];
  const typeMismatches: Array<{ key: string; expected: string; actual: string }> = [];

  if (!schema || Object.keys(schema).length === 0) {
    return {
      outcome: 'pass',
      score: 1.0,
      missingKeys: [],
      typeMismatches: [],
      message: `No schema declared for ${toolName} — skipping fit check`,
    };
  }

  const actual = actualInputs ?? {};
  const expectedKeys = Object.keys(schema);

  for (const key of expectedKeys) {
    if (!(key in actual)) {
      missingKeys.push(key);
      continue;
    }
    const expectedType = String(schema[key] ?? 'any');
    const actualType = jsType(actual[key]);
    if (!schemaTypeMatches(expectedType, actualType)) {
      typeMismatches.push({ key, expected: expectedType, actual: actualType });
    }
  }

  const issueCount = missingKeys.length + typeMismatches.length;
  const score = expectedKeys.length === 0
    ? 1.0
    : Math.max(0, (expectedKeys.length - issueCount) / expectedKeys.length);

  let outcome: ValidationOutcome = 'pass';
  if (issueCount > 0) outcome = options.fatal ? 'fail_fatal' : 'fail_warning';

  const summary = issueCount === 0
    ? `Schema-fit OK (${expectedKeys.length}/${expectedKeys.length} keys present, types match)`
    : `Schema-fit ${score.toFixed(2)} — missing: [${missingKeys.join(', ')}], type mismatches: ${typeMismatches.length}`;

  return { outcome, score, missingKeys, typeMismatches, message: summary };
}

/**
 * Module owns its prerequisite table. Creates `tool_validations` on first
 * call if migration 015 hasn't run (or got blocked upstream). Decoupled
 * from the migration runner so capability never silently no-ops.
 */
const _validationsEnsuredPaths = new Set<string>();
function ensureValidationsTable(): boolean {
  const dbPath = getDB();
  if (_validationsEnsuredPaths.has(dbPath)) return true;
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS tool_validations (` +
      `id TEXT PRIMARY KEY, ` +
      `tool_name TEXT NOT NULL, ` +
      `role_id TEXT, ` +
      `task_id TEXT, ` +
      `validation_outcome TEXT NOT NULL CHECK(validation_outcome IN ('pass','fail_warning','fail_fatal')), ` +
      `missing_keys TEXT, ` +
      `type_mismatches TEXT, ` +
      `score REAL, ` +
      `persona TEXT, ` +
      `session_id TEXT, ` +
      `created_at INTEGER DEFAULT (strftime('%s','now'))` +
      `); ` +
      `CREATE INDEX IF NOT EXISTS idx_tool_validations_tool ON tool_validations(tool_name, created_at DESC); ` +
      `CREATE INDEX IF NOT EXISTS idx_tool_validations_outcome ON tool_validations(validation_outcome, created_at DESC);`
    );
    _validationsEnsuredPaths.add(dbPath);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Persist a tool validation record to the tool_validations table.
 * Called by the swarm orchestrator before dispatch.
 */
export function storeValidation(record: ValidationRecord): void {
  if (!ensureValidationsTable()) return;

  let db: Database | null = null;
  try {
    db = new Database(getDB());
    db.query(
      `INSERT INTO tool_validations(id,tool_name,role_id,task_id,validation_outcome,missing_keys,type_mismatches,score,persona,session_id) ` +
      `VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      record.toolName.slice(0, 200),
      (record.roleId || '').slice(0, 200),
      (record.taskId || '').slice(0, 200),
      record.outcome,
      JSON.stringify(record.missingKeys || []).slice(0, 1000),
      JSON.stringify(record.typeMismatches || []).slice(0, 1000),
      record.score,
      (record.persona || '').slice(0, 100),
      (record.sessionId || '').slice(0, 100),
    );
  } catch {
    // best-effort persistence — never block dispatch on a validation write
  } finally {
    db?.close();
  }
}

export interface ValidationStats {
  total: number;
  pass: number;
  warning: number;
  fatal: number;
  passRate: number;
  avgScore: number;
}

/**
 * Aggregate validation stats over the last N days for a tool (or all tools).
 * Used by the score-execution-validation CLI.
 */
export function getValidationStats(opts: { toolName?: string; sinceDays?: number } = {}): ValidationStats {
  if (!ensureValidationsTable()) {
    return { total: 0, pass: 0, warning: 0, fatal: 0, passRate: 0, avgScore: 0 };
  }

  const since = opts.sinceDays
    ? Math.floor(Date.now() / 1000) - opts.sinceDays * 86400
    : 0;
  const params: Array<string | number> = [];
  let where = 'WHERE 1=1';
  if (opts.toolName) { where += ' AND tool_name = ?'; params.push(opts.toolName); }
  if (since) { where += ' AND created_at >= ?'; params.push(since); }

  let rows: Array<{ outcome: string; cnt: number; avg: number | null }> = [];
  let db: Database | null = null;
  try {
    db = new Database(getDB(), { readonly: true });
    rows = db.query(
      `SELECT validation_outcome AS outcome, COUNT(*) AS cnt, AVG(score) AS avg ` +
      `FROM tool_validations ${where} GROUP BY validation_outcome`
    ).all(...params) as Array<{ outcome: string; cnt: number; avg: number | null }>;
  } catch {
    rows = [];
  } finally {
    db?.close();
  }

  let pass = 0, warning = 0, fatal = 0;
  let totalScore = 0, scoreCount = 0;
  for (const row of rows) {
    const count = row.cnt ?? 0;
    const avg = row.avg ?? 0;
    if (row.outcome === 'pass') pass = count;
    else if (row.outcome === 'fail_warning') warning = count;
    else if (row.outcome === 'fail_fatal') fatal = count;
    totalScore += avg * count;
    scoreCount += count;
  }

  const total = pass + warning + fatal;
  return {
    total,
    pass,
    warning,
    fatal,
    passRate: total === 0 ? 0 : pass / total,
    avgScore: scoreCount === 0 ? 0 : totalScore / scoreCount,
  };
}

/**
 * Best-effort default extractor: build a `task.inputs` payload by mining
 * the prose `task.task` field plus optional structured hints.
 *
 * This is the bridge that satisfies the wire-what-you-build requirement —
 * even prose-only tasks get a populated `inputs` object so role schemas
 * can be checked against something concrete.
 */
export function deriveDefaultInputs(taskText: string, hints?: { ragContext?: string; tags?: string[] }): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (taskText && taskText.trim()) {
    inputs.task_spec = taskText.slice(0, 2000);
  }
  if (hints?.ragContext) {
    inputs.codebase_context = hints.ragContext.slice(0, 4000);
  }
  if (hints?.tags && hints.tags.length > 0) {
    inputs.tags = hints.tags.slice(0, 20);
  }
  // Heuristic: if the task mentions "design" / "brand", surface as design_brief
  const lower = (taskText || '').toLowerCase();
  if (lower.includes('design') || lower.includes('brand') || lower.includes('ui')) {
    inputs.design_brief = taskText.slice(0, 2000);
  }
  return inputs;
}
