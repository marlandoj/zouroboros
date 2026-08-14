import type { PlanArtifact } from '../types.js';

export function validPlan(overrides: Partial<PlanArtifact> = {}): PlanArtifact {
  return {
    id: 'plan-1',
    title: 'Verified implementation plan',
    risk: 'high',
    revision: 1,
    tasks: [
      {
        id: 'TASK-1',
        title: 'Implement the verified behavior',
        depends_on: [],
      },
    ],
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'The package compiles and all focused tests pass.' },
    ],
    exit_conditions: [
      { name: 'verified', criteria: 'Compilation and focused tests pass.' },
    ],
    rollback: 'Disable the feature flag and restore the prior consumer path.',
    protected_behavior: ['Existing consumers remain enabled by default.'],
    ...overrides,
  };
}
