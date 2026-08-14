import { describe, expect, test } from 'bun:test';
import { validPlan } from './fixtures.js';
import { validatePlanArtifact, validatePlanArtifactFromString } from '../validate.js';

function ruleIds(plan: Parameters<typeof validatePlanArtifact>[0]): string[] {
  return validatePlanArtifact(plan, { workspaceRoot: process.cwd(), checkPaths: false })
    .findings.map((finding) => finding.rule_id);
}

describe('validatePlanArtifact', () => {
  test('accepts a complete plan', () => {
    const result = validatePlanArtifact(validPlan(), {
      workspaceRoot: process.cwd(),
      checkPaths: false,
    });
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test('rejects unknown dependencies', () => {
    const plan = validPlan({
      tasks: [{ id: 'TASK-1', title: 'Broken dependency', depends_on: ['TASK-404'] }],
    });
    expect(ruleIds(plan)).toContain('TASK_UNKNOWN_DEPENDENCY');
    expect(validatePlanArtifact(plan, { checkPaths: false }).passed).toBe(false);
  });

  test('rejects dependency cycles', () => {
    const plan = validPlan({
      tasks: [
        { id: 'TASK-1', title: 'First task', depends_on: ['TASK-2'] },
        { id: 'TASK-2', title: 'Second task', depends_on: ['TASK-1'] },
      ],
    });
    expect(ruleIds(plan)).toContain('TASK_DEPENDENCY_CYCLE');
  });

  test('rejects same-wave path conflicts', () => {
    const plan = validPlan({
      tasks: [
        { id: 'TASK-1', title: 'First writer', paths: ['packages/workflow/src/index.ts'] },
        { id: 'TASK-2', title: 'Second writer', paths: ['packages/workflow/src/index.ts'] },
      ],
    });
    const result = validatePlanArtifact(plan, { checkPaths: false });
    expect(result.findings.map((finding) => finding.rule_id)).toContain('WAVE_WRITE_CONFLICT');
    expect(result.passed).toBe(false);
  });

  test('rejects missing rollback and exit conditions', () => {
    const plan = validPlan({ rollback: null, exit_conditions: [] });
    const ids = ruleIds(plan);
    expect(ids).toContain('ROLLBACK_MISSING');
    expect(ids).toContain('EXIT_CONDITIONS_EMPTY');
  });

  test('returns a typed parse error', () => {
    const result = validatePlanArtifactFromString('{not json', 'json');
    expect(result.passed).toBe(false);
    expect(result.findings[0]?.rule_id).toBe('PARSE_ERROR');
    expect(result.findings[0]?.category).toBe('malformed_output');
  });
});
