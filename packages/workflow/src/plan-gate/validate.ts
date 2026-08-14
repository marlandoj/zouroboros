/**
 * PCG-003: Deterministic, model-free plan validator.
 *
 * Validates plan artifacts against structural, dependency, path, quality, and
 * policy rules without making any provider or network calls.
 *
 * validatePlanArtifact  – accepts a pre-parsed PlanArtifact.
 * validatePlanArtifactFromString – parses first; returns findings on parse failure.
 *
 * Rules implemented
 * ─────────────────
 * Schema:        SCHEMA_NOT_OBJECT, SCHEMA_MISSING_REQUIRED_FIELD,
 *                SCHEMA_EMPTY_ID, SCHEMA_EMPTY_TITLE, SCHEMA_INVALID_RISK,
 *                SCHEMA_INVALID_TASKS, SCHEMA_INVALID_ACCEPTANCE_CRITERIA,
 *                SCHEMA_INVALID_EXIT_CONDITIONS
 * Tasks:         TASK_INVALID_ENTRY, TASK_EMPTY_ID, TASK_DUPLICATE_ID,
 *                TASK_EMPTY_TITLE
 * Dependencies:  TASK_INVALID_DEPENDENCY_VALUE, TASK_UNKNOWN_DEPENDENCY,
 *                TASK_DEPENDENCY_CYCLE
 * Paths:         PATH_ABSOLUTE, PATH_TRAVERSAL, PATH_PACKAGE_BOUNDARY_VIOLATION
 * Same-wave:     WAVE_WRITE_CONFLICT
 * AC quality:    AC_EMPTY, AC_EMPTY_CRITERION, AC_VAGUE_CRITERION, AC_DUPLICATE
 * Rollback:      ROLLBACK_MISSING, ROLLBACK_EMPTY_STRING
 * Exit:          EXIT_CONDITIONS_EMPTY, EXIT_CONDITION_INVALID,
 *                EXIT_CONDITION_MISSING_NAME, EXIT_CONDITION_MISSING_CRITERIA
 * Protected:     PROTECTED_BEHAVIOR_MALFORMED
 * Parse:         PARSE_ERROR
 */

import type {
  PlanArtifact,
  PlanTask,
  DeterministicReport,
  DeterministicFinding,
  FindingType,
  FindingSeverity,
} from './types.js';
import { parsePlanArtifactInput } from './canonicalize.js';
import type { CanonicalizeFormat } from './canonicalize.js';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_RISKS = new Set(['high', 'medium', 'low']);
const MIN_AC_CRITERION_LENGTH = 10;

export interface PlanValidationOptions {
  workspaceRoot?: string;
  checkPaths?: boolean;
}

// ---------------------------------------------------------------------------
// Internal finding builder
// ---------------------------------------------------------------------------

function makeFinding(
  rule_id: string,
  severity: FindingSeverity,
  category: FindingType,
  message: string,
  opts: { evidence?: string; task_id?: string; path?: string } = {}
): DeterministicFinding {
  const f: DeterministicFinding = { rule_id, severity, category, message };
  if (opts.evidence !== undefined) f.evidence = opts.evidence;
  if (opts.task_id !== undefined) f.task_id = opts.task_id;
  if (opts.path !== undefined) f.path = opts.path;
  return f;
}

// ---------------------------------------------------------------------------
// Cycle detection (DFS over dependency graph)
// ---------------------------------------------------------------------------

function detectDependencyCycles(tasks: PlanTask[]): string[][] {
  const taskMap = new Map<string, PlanTask>();
  for (const t of tasks) {
    if (typeof t.id === 'string' && t.id.trim() !== '') {
      taskMap.set(t.id, t);
    }
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      const cycleStart = path.indexOf(id);
      if (cycleStart >= 0) {
        cycles.push([...path.slice(cycleStart), id]);
      }
      return;
    }
    if (visited.has(id)) return;

    inStack.add(id);
    path.push(id);

    const task = taskMap.get(id);
    const deps = (task?.depends_on ?? []).filter(
      (d) => typeof d === 'string' && taskMap.has(d)
    );
    for (const dep of deps) {
      dfs(dep, path);
    }

    path.pop();
    inStack.delete(id);
    visited.add(id);
  }

  for (const id of taskMap.keys()) {
    if (!visited.has(id)) dfs(id, []);
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Wave computation (topological depth for parallel-execution wave assignment)
// ---------------------------------------------------------------------------

function computeTaskWaves(tasks: PlanTask[]): Map<string, number> {
  const taskMap = new Map<string, PlanTask>();
  for (const t of tasks) {
    if (typeof t.id === 'string' && t.id.trim() !== '') taskMap.set(t.id, t);
  }

  const memo = new Map<string, number>();

  function wave(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    const task = taskMap.get(id);
    const deps = (task?.depends_on ?? []).filter(
      (d) => typeof d === 'string' && taskMap.has(d)
    );
    const w = deps.length === 0 ? 0 : Math.max(...deps.map(wave)) + 1;
    memo.set(id, w);
    return w;
  }

  for (const id of taskMap.keys()) wave(id);
  return memo;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function hasPathTraversal(p: string): boolean {
  return (
    p.includes('../') ||
    p.includes('..\\') ||
    p === '..' ||
    p.endsWith('/..') ||
    p.endsWith('\\..')
  );
}

/** Return the top-level package directory for a path like packages/foo/... or Skills/foo/... */
function extractPackageDir(p: string): string | null {
  const m = /^(packages\/[^/]+|Skills\/[^/]+)\//.exec(p);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Rule validators
// ---------------------------------------------------------------------------

function checkSchema(artifact: unknown): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];

  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    findings.push(
      makeFinding(
        'SCHEMA_NOT_OBJECT',
        'blocker',
        'substantive',
        'Plan artifact must be a non-null object.',
        { evidence: `Received type: ${artifact === null ? 'null' : typeof artifact}` }
      )
    );
    return findings;
  }

  const a = artifact as Record<string, unknown>;
  const requiredFields = [
    'id',
    'title',
    'tasks',
    'acceptance_criteria',
    'exit_conditions',
    'rollback',
  ];

  for (const field of requiredFields) {
    if (!(field in a) || a[field] === undefined) {
      findings.push(
        makeFinding(
          'SCHEMA_MISSING_REQUIRED_FIELD',
          'blocker',
          'substantive',
          `Required field '${field}' is missing from the plan artifact.`,
          { evidence: `Missing field: ${field}` }
        )
      );
    }
  }

  if ('id' in a && (typeof a['id'] !== 'string' || (a['id'] as string).trim() === '')) {
    findings.push(
      makeFinding(
        'SCHEMA_EMPTY_ID',
        'blocker',
        'substantive',
        'Plan artifact id must be a non-empty string.',
        { evidence: `id: ${JSON.stringify(a['id'])}` }
      )
    );
  }

  if ('title' in a && (typeof a['title'] !== 'string' || (a['title'] as string).trim() === '')) {
    findings.push(
      makeFinding(
        'SCHEMA_EMPTY_TITLE',
        'high',
        'substantive',
        'Plan artifact title must be a non-empty string.',
        { evidence: `title: ${JSON.stringify(a['title'])}` }
      )
    );
  }

  if ('risk' in a && a['risk'] !== undefined && !VALID_RISKS.has(a['risk'] as string)) {
    findings.push(
      makeFinding(
        'SCHEMA_INVALID_RISK',
        'blocker',
        'substantive',
        `Plan risk must be one of: high, medium, low. Got: '${String(a['risk'])}'.`,
        { evidence: `risk: ${JSON.stringify(a['risk'])}` }
      )
    );
  }

  if ('tasks' in a && !Array.isArray(a['tasks'])) {
    findings.push(
      makeFinding(
        'SCHEMA_INVALID_TASKS',
        'blocker',
        'substantive',
        'Plan tasks must be an array.',
        { evidence: `tasks type: ${typeof a['tasks']}` }
      )
    );
  }

  if ('acceptance_criteria' in a && !Array.isArray(a['acceptance_criteria'])) {
    findings.push(
      makeFinding(
        'SCHEMA_INVALID_ACCEPTANCE_CRITERIA',
        'blocker',
        'substantive',
        'Plan acceptance_criteria must be an array.',
        { evidence: `acceptance_criteria type: ${typeof a['acceptance_criteria']}` }
      )
    );
  }

  if ('exit_conditions' in a && !Array.isArray(a['exit_conditions'])) {
    findings.push(
      makeFinding(
        'SCHEMA_INVALID_EXIT_CONDITIONS',
        'blocker',
        'substantive',
        'Plan exit_conditions must be an array.',
        { evidence: `exit_conditions type: ${typeof a['exit_conditions']}` }
      )
    );
  }

  return findings;
}

function checkTasks(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!Array.isArray(artifact.tasks)) return findings;

  const seenIds = new Set<string>();

  for (let i = 0; i < artifact.tasks.length; i++) {
    const task = artifact.tasks[i];

    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      findings.push(
        makeFinding(
          'TASK_INVALID_ENTRY',
          'blocker',
          'substantive',
          `Task at index ${i} is not a valid object.`,
          { evidence: `tasks[${i}]: ${JSON.stringify(task)}` }
        )
      );
      continue;
    }

    const rawId = task['id'];
    if (!rawId || typeof rawId !== 'string' || rawId.trim() === '') {
      findings.push(
        makeFinding(
          'TASK_EMPTY_ID',
          'blocker',
          'substantive',
          `Task at index ${i} has an empty or missing id.`,
          { evidence: `tasks[${i}].id: ${JSON.stringify(rawId)}` }
        )
      );
    } else {
      const tid = rawId.trim();
      if (seenIds.has(tid)) {
        findings.push(
          makeFinding(
            'TASK_DUPLICATE_ID',
            'blocker',
            'substantive',
            `Duplicate task id '${tid}'; each task id must be unique within a plan.`,
            { evidence: `Task id '${tid}' appears more than once`, task_id: tid }
          )
        );
      }
      seenIds.add(tid);
    }

    const rawTitle = task['title'];
    if (!rawTitle || typeof rawTitle !== 'string' || rawTitle.trim() === '') {
      findings.push(
        makeFinding(
          'TASK_EMPTY_TITLE',
          'medium',
          'substantive',
          `Task '${String(task['id'] ?? i)}' has an empty or missing title.`,
          {
            evidence: `tasks[${i}].title: ${JSON.stringify(rawTitle)}`,
            task_id: typeof task['id'] === 'string' ? task['id'] : undefined,
          }
        )
      );
    }
  }

  return findings;
}

function checkDependencies(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!Array.isArray(artifact.tasks)) return findings;

  const taskIds = new Set(
    artifact.tasks
      .filter((t) => typeof t['id'] === 'string' && (t['id'] as string).trim() !== '')
      .map((t) => t['id'] as string)
  );

  for (const task of artifact.tasks) {
    if (!task || typeof task['id'] !== 'string') continue;
    const taskId = task['id'] as string;
    const deps = task['depends_on'];
    if (!Array.isArray(deps)) continue;

    for (const dep of deps) {
      if (typeof dep !== 'string' || dep.trim() === '') {
        findings.push(
          makeFinding(
            'TASK_INVALID_DEPENDENCY_VALUE',
            'high',
            'substantive',
            `Task '${taskId}' has an invalid depends_on entry; each dependency must be a non-empty string task id.`,
            { evidence: `depends_on entry: ${JSON.stringify(dep)}`, task_id: taskId }
          )
        );
      } else if (!taskIds.has(dep)) {
        findings.push(
          makeFinding(
            'TASK_UNKNOWN_DEPENDENCY',
            'blocker',
            'substantive',
            `Task '${taskId}' depends on unknown task '${dep}'.`,
            {
              evidence: `depends_on: '${dep}' not found among task ids: [${[...taskIds].join(', ')}]`,
              task_id: taskId,
            }
          )
        );
      }
    }
  }

  const cycles = detectDependencyCycles(artifact.tasks);
  for (const cycle of cycles) {
    findings.push(
      makeFinding(
        'TASK_DEPENDENCY_CYCLE',
        'blocker',
        'substantive',
        `Circular dependency detected: ${cycle.join(' → ')}.`,
        { evidence: `Cycle path: ${cycle.join(' → ')}`, task_id: cycle[0] }
      )
    );
  }

  return findings;
}

function checkPaths(artifact: PlanArtifact, options: PlanValidationOptions): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!Array.isArray(artifact.tasks)) return findings;

  for (const task of artifact.tasks) {
    if (!task || !Array.isArray(task['paths'])) continue;
    const taskId =
      typeof task['id'] === 'string' ? (task['id'] as string) : undefined;
    const packageDirs = new Set<string>();

    for (const p of task['paths'] as unknown[]) {
      if (typeof p !== 'string') continue;

      const workspaceRoot = resolve(options.workspaceRoot ?? process.env['ZO_WORKSPACE'] ?? process.cwd());
      const resolvedPath = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
      const rel = relative(workspaceRoot, resolvedPath);
      const outsideWorkspace = rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);

      if (isAbsolutePath(p) && outsideWorkspace) {
        findings.push(
          makeFinding(
            'PATH_OUTSIDE_WORKSPACE',
            'blocker',
            'infrastructure',
            `Task '${String(taskId ?? task['id'])}' declares a path outside the workspace: '${p}'.`,
            { evidence: `path: ${p}`, task_id: taskId, path: p }
          )
        );
      }

      if (hasPathTraversal(p)) {
        findings.push(
          makeFinding(
            'PATH_TRAVERSAL',
            'high',
            'infrastructure',
            `Task '${String(taskId ?? task['id'])}' declares a path with directory traversal: '${p}'.`,
            { evidence: `path: ${p}`, task_id: taskId, path: p }
          )
        );
      }

      if (options.checkPaths !== false && !existsSync(resolvedPath) && !existsSync(dirname(resolvedPath))) {
        findings.push(
          makeFinding(
            'PATH_NOT_FOUND',
            'high',
            'infrastructure',
            `Task '${String(taskId ?? task['id'])}' declares a path whose file and parent directory do not exist: '${p}'.`,
            { evidence: `resolved path: ${resolvedPath}`, task_id: taskId, path: p }
          )
        );
      }

      const pkgDir = extractPackageDir(p);
      if (pkgDir) packageDirs.add(pkgDir);
    }

    if (packageDirs.size > 1) {
      const dirs = [...packageDirs].sort().join(', ');
      findings.push(
        makeFinding(
          'PATH_PACKAGE_BOUNDARY_VIOLATION',
          'medium',
          'infrastructure',
          `Task '${String(taskId ?? task['id'])}' spans multiple package directories: ${dirs}.`,
          { evidence: `Package directories: ${dirs}`, task_id: taskId }
        )
      );
    }
  }

  return findings;
}

function checkWaveConflicts(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!Array.isArray(artifact.tasks) || artifact.tasks.length === 0) return findings;

  // Skip wave check when cycles exist — wave computation requires a DAG.
  if (detectDependencyCycles(artifact.tasks).length > 0) return findings;

  const waveMap = computeTaskWaves(artifact.tasks);

  // Group tasks by wave
  const waveGroups = new Map<number, PlanTask[]>();
  for (const task of artifact.tasks) {
    if (typeof task['id'] !== 'string') continue;
    const w = waveMap.get(task['id'] as string) ?? 0;
    const bucket = waveGroups.get(w);
    if (bucket) bucket.push(task);
    else waveGroups.set(w, [task]);
  }

  // Detect same-wave write conflicts
  for (const [wave, tasks] of waveGroups) {
    const pathToTaskIds = new Map<string, string[]>();
    for (const task of tasks) {
      const taskId = task['id'] as string;
      if (!Array.isArray(task['paths'])) continue;
      for (const p of task['paths'] as unknown[]) {
        if (typeof p !== 'string') continue;
        const bucket = pathToTaskIds.get(p);
        if (bucket) bucket.push(taskId);
        else pathToTaskIds.set(p, [taskId]);
      }
    }

    for (const [p, taskIds] of pathToTaskIds) {
      if (taskIds.length > 1) {
        findings.push(
          makeFinding(
            'WAVE_WRITE_CONFLICT',
            'high',
            'substantive',
            `Same-wave write conflict in wave ${wave}: tasks ${taskIds.join(', ')} all declare path '${p}'.`,
            {
              evidence: `Wave ${wave}, conflicting path '${p}', tasks: ${taskIds.join(', ')}`,
              path: p,
            }
          )
        );
      }
    }
  }

  return findings;
}

function checkAcceptanceCriteria(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!Array.isArray(artifact.acceptance_criteria)) return findings;

  if (artifact.acceptance_criteria.length === 0) {
    const severity: FindingSeverity = artifact.risk === 'high' ? 'blocker' : 'high';
    findings.push(
      makeFinding(
        'AC_EMPTY',
        severity,
        'substantive',
        'Plan has no acceptance criteria; measurable success conditions are required.',
        { evidence: 'acceptance_criteria: []' }
      )
    );
    return findings;
  }

  const seenNormalized = new Set<string>();
  for (let i = 0; i < artifact.acceptance_criteria.length; i++) {
    const rawCriterion = artifact.acceptance_criteria[i];
    const criterion = typeof rawCriterion === 'string'
      ? rawCriterion
      : rawCriterion && typeof rawCriterion === 'object'
        ? rawCriterion.criterion
        : undefined;

    if (typeof criterion !== 'string' || criterion.trim() === '') {
      findings.push(
        makeFinding(
          'AC_EMPTY_CRITERION',
          'medium',
          'substantive',
          `Acceptance criterion at index ${i} is empty or not a string.`,
          { evidence: `acceptance_criteria[${i}]: ${JSON.stringify(rawCriterion)}` }
        )
      );
      continue;
    }

    const trimmed = criterion.trim();

    if (trimmed.length < MIN_AC_CRITERION_LENGTH) {
      findings.push(
        makeFinding(
          'AC_VAGUE_CRITERION',
          'low',
          'substantive',
          `Acceptance criterion at index ${i} is too short to be actionable (< ${MIN_AC_CRITERION_LENGTH} chars).`,
          { evidence: `criterion: ${JSON.stringify(trimmed)}` }
        )
      );
    }

    const key = trimmed.toLowerCase();
    if (seenNormalized.has(key)) {
      findings.push(
        makeFinding(
          'AC_DUPLICATE',
          'medium',
          'substantive',
          `Duplicate acceptance criterion at index ${i}.`,
          { evidence: `criterion: ${JSON.stringify(trimmed)}` }
        )
      );
    }
    seenNormalized.add(key);
  }

  return findings;
}

function checkRollback(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];

  if (artifact.rollback === null) {
    const severity: FindingSeverity =
      artifact.risk === 'high' ? 'blocker' : artifact.risk === 'medium' ? 'medium' : 'low';
    findings.push(
      makeFinding(
        'ROLLBACK_MISSING',
        severity,
        'substantive',
        artifact.risk === 'high'
          ? 'High-risk plan has no rollback procedure; rollback is required for high-risk changes.'
          : 'Plan has no rollback procedure; consider documenting a rollback path.',
        { evidence: `rollback: null, risk: ${artifact.risk}` }
      )
    );
    return findings;
  }

  if (typeof artifact.rollback === 'string' && artifact.rollback.trim() === '') {
    findings.push(
      makeFinding(
        'ROLLBACK_EMPTY_STRING',
        'high',
        'substantive',
        "Plan rollback field is an empty string; describe a rollback procedure or set to null.",
        { evidence: 'rollback: ""' }
      )
    );
  }

  if (
    artifact.rollback !== null &&
    typeof artifact.rollback === 'object' &&
    !Array.isArray(artifact.rollback) &&
    Object.keys(artifact.rollback).length === 0
  ) {
    findings.push(
      makeFinding(
        'ROLLBACK_EMPTY_OBJECT',
        'high',
        'substantive',
        'Plan rollback object is empty; define triggers, action, or verification.',
        { evidence: 'rollback: {}' }
      )
    );
  }

  return findings;
}

function checkExitConditions(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!Array.isArray(artifact.exit_conditions)) return findings;

  if (artifact.exit_conditions.length === 0) {
    findings.push(
      makeFinding(
        'EXIT_CONDITIONS_EMPTY',
        'high',
        'substantive',
        'Plan has no exit conditions; define at least one clear stopping criterion.',
        { evidence: 'exit_conditions: []' }
      )
    );
    return findings;
  }

  for (let i = 0; i < artifact.exit_conditions.length; i++) {
    const ec = artifact.exit_conditions[i];

    if (!ec || typeof ec !== 'object' || Array.isArray(ec)) {
      findings.push(
        makeFinding(
          'EXIT_CONDITION_INVALID',
          'medium',
          'substantive',
          `Exit condition at index ${i} is not a valid object.`,
          { evidence: `exit_conditions[${i}]: ${JSON.stringify(ec)}` }
        )
      );
      continue;
    }

    const ecObj = ec as unknown as Record<string, unknown>;

    if (!ecObj['name'] || typeof ecObj['name'] !== 'string' || (ecObj['name'] as string).trim() === '') {
      findings.push(
        makeFinding(
          'EXIT_CONDITION_MISSING_NAME',
          'medium',
          'substantive',
          `Exit condition at index ${i} is missing a name.`,
          { evidence: `exit_conditions[${i}]: ${JSON.stringify(ec)}` }
        )
      );
    }

    if (
      !ecObj['criteria'] ||
      typeof ecObj['criteria'] !== 'string' ||
      (ecObj['criteria'] as string).trim() === ''
    ) {
      findings.push(
        makeFinding(
          'EXIT_CONDITION_MISSING_CRITERIA',
          'medium',
          'substantive',
          `Exit condition '${String(ecObj['name'] ?? i)}' has no criteria defined.`,
          { evidence: `exit_conditions[${i}].criteria: ${JSON.stringify(ecObj['criteria'])}` }
        )
      );
    }
  }

  return findings;
}

function checkProtectedBehaviors(artifact: PlanArtifact): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!('protected_behaviors' in artifact) && !('protected_behavior' in artifact)) return findings;

  const pb = artifact['protected_behaviors'] ?? artifact['protected_behavior'];
  if (!Array.isArray(pb)) {
    findings.push(
      makeFinding(
        'PROTECTED_BEHAVIOR_MALFORMED',
        'medium',
        'substantive',
        'Plan declares protected_behaviors but it is not an array of strings.',
        { evidence: `protected_behaviors type: ${typeof pb}` }
      )
    );
    return findings;
  }

  for (let i = 0; i < pb.length; i++) {
    const entry = pb[i];
    if (typeof entry !== 'string' || entry.trim() === '') {
      findings.push(
        makeFinding(
          'PROTECTED_BEHAVIOR_MALFORMED',
          'medium',
          'substantive',
          `protected_behaviors[${i}] must be a non-empty string.`,
          { evidence: `protected_behaviors[${i}]: ${JSON.stringify(entry)}` }
        )
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministically validate a pre-parsed plan artifact.
 *
 * Returns a DeterministicReport with a `passed` flag and typed findings.
 * `passed` is false when any finding has severity 'blocker' or 'high'.
 * Never throws — all internal errors become VALIDATE_INTERNAL_ERROR findings.
 * No provider calls or network I/O are performed.
 */
export function validatePlanArtifact(
  artifact: PlanArtifact,
  options: PlanValidationOptions = {}
): DeterministicReport {
  const all: DeterministicFinding[] = [];

  try {
    // 1. Schema — run first; later checks assume basic shape is valid
    const schemaFindings = checkSchema(artifact);
    all.push(...schemaFindings);

    const criticalSchemaFailure = schemaFindings.some((f) => f.severity === 'blocker');

    // Run task/dep/path checks only when we at least have an array for tasks
    if (!criticalSchemaFailure || Array.isArray((artifact as unknown as Record<string, unknown>)['tasks'])) {
      all.push(...checkTasks(artifact));
      all.push(...checkDependencies(artifact));
      all.push(...checkPaths(artifact, options));
      all.push(...checkWaveConflicts(artifact));
    }

    // Quality checks — run regardless of schema errors if the field is an array
    if (Array.isArray((artifact as unknown as Record<string, unknown>)['acceptance_criteria'])) {
      all.push(...checkAcceptanceCriteria(artifact));
    }

    all.push(...checkRollback(artifact));

    if (Array.isArray((artifact as unknown as Record<string, unknown>)['exit_conditions'])) {
      all.push(...checkExitConditions(artifact));
    }

    all.push(...checkProtectedBehaviors(artifact));
  } catch (err) {
    all.push(
      makeFinding(
        'VALIDATE_INTERNAL_ERROR',
        'blocker',
        'substantive',
        'Unexpected error during deterministic validation.',
        { evidence: err instanceof Error ? err.message : String(err) }
      )
    );
  }

  const passed = !all.some((f) => f.severity === 'blocker' || f.severity === 'high');
  return { passed, findings: all };
}

/**
 * Parse a raw plan artifact string, then validate it deterministically.
 *
 * Parse failures return a PARSE_ERROR finding with passed: false rather than
 * throwing, so callers receive a consistent DeterministicReport in all cases.
 */
export function validatePlanArtifactFromString(
  input: string,
  format: CanonicalizeFormat,
  options: PlanValidationOptions = {}
): DeterministicReport {
  try {
    const parsed = parsePlanArtifactInput(input, format) as PlanArtifact;
    return validatePlanArtifact(parsed, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      findings: [
        makeFinding(
          'PARSE_ERROR',
          'blocker',
          'malformed_output',
          `Failed to parse plan artifact as ${format}: ${message}`,
          { evidence: message }
        ),
      ],
    };
  }
}
