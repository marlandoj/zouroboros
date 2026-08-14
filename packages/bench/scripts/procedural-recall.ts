export interface ProcedureForRecall {
  name: string;
  version: number;
  steps: Array<{ executor: string; taskPattern: string }>;
}

export function selectFinalStepEntries(
  procedures: ProcedureForRecall[],
  executor: string,
): string[] {
  return procedures
    .filter((procedure) => procedure.steps.at(-1)?.executor === executor)
    .map((procedure) => {
      const finalStep = procedure.steps.at(-1)!;
      return `${procedure.name} v${procedure.version}: FINAL step (Step ${procedure.steps.length}) executor = ${finalStep.executor} ("${finalStep.taskPattern}")`;
    });
}
