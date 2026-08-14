/**
 * Tool Reflection store — M10 W2 t5
 *
 * Implements the ToolACE-R / Reflexion failure-heuristic loop:
 * When a tool call fails, callers persist a structured reflection describing
 * the failure class and a heuristic to avoid it next time. On subsequent
 * invocations, `getToolReflections` surfaces relevant heuristics so the
 * prescribe seed can factor them in.
 *
 * Storage: tool_reflections table in shared-facts.db (migration 014).
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getMemoryDbPath } from 'zouroboros-core';

function getDB(): string { return getMemoryDbPath(); }

export type FailureClass =
  | 'wrong_arguments'
  | 'missing_required_arg'
  | 'type_mismatch'
  | 'permission_denied'
  | 'timeout'
  | 'not_found'
  | 'api_error'
  | 'schema_mismatch'
  | 'other';

export interface ToolReflection {
  id: string;
  tool_name: string;
  failure_class: FailureClass;
  heuristic: string;
  evidence: string | null;
  applied_count: number;
  created_at: number;
}

/**
 * Module owns its prerequisite tables. Creates `tool_reflections` and
 * `swarm_task_evals` on first call if migrations 013/014/019 haven't run
 * (or got blocked upstream). Without this guard W1+W2 silently shipped
 * with dead persistence — the migration runner can halt mid-chain.
 */
const _ensuredPaths = new Set<string>();
function ensureTables(): boolean {
  const dbPath = getDB();
  if (_ensuredPaths.has(dbPath)) return true;
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS tool_reflections (` +
      `id TEXT PRIMARY KEY, ` +
      `tool_name TEXT NOT NULL, ` +
      `failure_class TEXT NOT NULL, ` +
      `heuristic TEXT NOT NULL, ` +
      `evidence TEXT, ` +
      `applied_count INTEGER DEFAULT 0, ` +
      `last_applied_at INTEGER, ` +
      `created_at INTEGER DEFAULT (strftime('%s','now')), ` +
      `updated_at INTEGER DEFAULT (strftime('%s','now'))` +
      `); ` +
      `CREATE INDEX IF NOT EXISTS idx_tool_reflections_tool ON tool_reflections(tool_name, updated_at DESC); ` +
      `CREATE TABLE IF NOT EXISTS swarm_task_evals (` +
      `id TEXT PRIMARY KEY, ` +
      `tool_name TEXT NOT NULL, ` +
      `tool_args TEXT, ` +
      `outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','partial')), ` +
      `precision_score REAL, ` +
      `recall_score REAL, ` +
      `argument_accuracy REAL, ` +
      `error_type TEXT, ` +
      `error_message TEXT, ` +
      `duration_ms INTEGER, ` +
      `persona TEXT, ` +
      `session_id TEXT, ` +
      `created_at INTEGER DEFAULT (strftime('%s','now'))` +
      `); ` +
      `CREATE INDEX IF NOT EXISTS idx_swarm_task_evals_task ON swarm_task_evals(tool_name, created_at DESC); ` +
      `CREATE INDEX IF NOT EXISTS idx_swarm_task_evals_outcome ON swarm_task_evals(outcome, created_at DESC);`
    );
    _ensuredPaths.add(dbPath);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Persist a tool failure reflection.
 * Idempotent by heuristic content per tool — updates applied_count if the
 * same heuristic is already stored rather than inserting a duplicate.
 */
export function storeToolReflection(
  toolName: string,
  failureClass: FailureClass,
  heuristic: string,
  evidence?: string
): void {
  if (!ensureTables()) return;

  const heu = heuristic.slice(0, 500);
  let db: Database | null = null;
  try {
    db = new Database(getDB());
    const existing = db.query(
      `SELECT id FROM tool_reflections WHERE tool_name = ? AND heuristic = ? LIMIT 1`
    ).get(toolName, heu) as { id: string } | null;

    if (existing) {
      db.query(
        `UPDATE tool_reflections SET applied_count=applied_count+1, updated_at=strftime('%s','now') WHERE id = ?`
      ).run(existing.id);
      return;
    }

    db.query(
      `INSERT INTO tool_reflections(id,tool_name,failure_class,heuristic,evidence) VALUES(?,?,?,?,?)`
    ).run(randomUUID(), toolName, failureClass, heu, evidence ? evidence.slice(0, 500) : '');
  } catch {
    // best-effort persistence
  } finally {
    db?.close();
  }
}

/**
 * Retrieve all reflections for a given tool, ordered by most-applied first.
 * Returns an empty array when the DB is unavailable or the table doesn't exist.
 */
export function getToolReflections(toolName: string): ToolReflection[] {
  if (!ensureTables()) return [];

  let db: Database | null = null;
  try {
    db = new Database(getDB(), { readonly: true });
    const rows = db.query(
      `SELECT id,tool_name,failure_class,heuristic,evidence,applied_count,created_at FROM tool_reflections WHERE tool_name = ? ORDER BY applied_count DESC LIMIT 10`
    ).all(toolName) as Array<{
      id: string; tool_name: string; failure_class: string;
      heuristic: string; evidence: string | null; applied_count: number; created_at: number;
    }>;
    return rows.map(r => ({
      id: r.id ?? '',
      tool_name: r.tool_name ?? toolName,
      failure_class: (r.failure_class ?? 'other') as FailureClass,
      heuristic: r.heuristic ?? '',
      evidence: r.evidence || null,
      applied_count: r.applied_count ?? 0,
      created_at: r.created_at ?? 0,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

// ─── Tool Eval Storage ────────────────────────────────────────────────────────

export interface ToolEvalRecord {
  toolName: string;
  outcome: 'success' | 'failure' | 'partial';
  durationMs: number;
  errorType?: string;
  errorMessage?: string;
  persona?: string;
  sessionId?: string;
  toolArgs?: Record<string, unknown>;
}

/**
 * Classify an error message into a FailureClass for structured reflection.
 */
export function classifyFailure(error: string): FailureClass {
  const msg = error.toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) return 'not_found';
  if (msg.includes('permission') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('403')) return 'permission_denied';
  if (msg.includes('type') || msg.includes('expected string') || msg.includes('expected number')) return 'type_mismatch';
  if (msg.includes('required') || msg.includes('missing')) return 'missing_required_arg';
  if (msg.includes('schema') || msg.includes('invalid argument') || msg.includes('invalid param')) return 'schema_mismatch';
  if (msg.includes('api') || msg.includes('500') || msg.includes('503') || msg.includes('rate limit')) return 'api_error';
  return 'other';
}

/**
 * Persist a swarm task evaluation record to the swarm_task_evals table.
 * Called after every task execution (success or failure) in the DAG executor.
 * The tool_name column holds the swarm taskId (e.g. "t7"); actual Claude/Zo
 * tool invocations are recorded separately in `tool_calls` by the
 * post-tool-eval-hook.
 */
export function storeSwarmTaskEval(record: ToolEvalRecord): void {
  if (!ensureTables()) return;

  let db: Database | null = null;
  try {
    db = new Database(getDB());
    db.query(
      `INSERT INTO swarm_task_evals(id,tool_name,tool_args,outcome,error_type,error_message,duration_ms,persona,session_id) ` +
      `VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      record.toolName,
      record.toolArgs ? JSON.stringify(record.toolArgs).slice(0, 1000) : '',
      record.outcome,
      (record.errorType || '').slice(0, 200),
      (record.errorMessage || '').slice(0, 500),
      record.durationMs,
      (record.persona || '').slice(0, 100),
      (record.sessionId || '').slice(0, 100),
    );
  } catch {
    // best-effort persistence
  } finally {
    db?.close();
  }
}

// ─── Reflection Formatting ────────────────────────────────────────────────────

/**
 * Format reflections as a compact prompt block for injection into a
 * prescription seed or LLM system prompt.
 */
export function formatReflectionsForSeed(toolName: string): string {
  const reflections = getToolReflections(toolName);
  if (reflections.length === 0) return '';

  const lines = [`Tool reflection history for "${toolName}":`];
  for (const r of reflections) {
    lines.push(`  [${r.failure_class}] ${r.heuristic} (seen ${r.applied_count}×)`);
  }
  return lines.join('\n');
}
