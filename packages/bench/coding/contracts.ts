import { createHash } from "node:crypto";

export const CODE_BENCHMARK_NAME = "ZouroBench-Code" as const;
export const CODE_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const CODE_BENCHMARK_HARNESS_VERSION = "1.0.0";
export const CODE_BENCHMARK_FOLDS = [1, 2, 3, 4, 5] as const;

export type CodeTaskCategory =
  | "bug-fix"
  | "feature"
  | "integration"
  | "refactor"
  | "test-creation";

export interface CodingTaskManifest {
  id: string;
  fold: number;
  seed: number;
  category: CodeTaskCategory;
  title: string;
  prompt: string;
  targetFile: string;
  starterDir: string;
  solutionDir: string;
  hiddenChecksDir: string;
  mutationFile: string;
  timeoutMs: number;
  maxChangedFiles: number;
  maxChangedLines: number;
  requiredCommands: string[][];
  hiddenCommands: string[][];
}

export interface CodingCorpusManifest {
  schemaVersion: 1;
  benchmark: typeof CODE_BENCHMARK_NAME;
  corpusVersion: string;
  generatedAt: string;
  policy: "five-fold-typescript-bun-v1";
  tasks: CodingTaskManifest[];
}

export interface CodingCheckResult {
  id: string;
  kind: "required" | "hidden" | "mutation";
  command: string[];
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface CodingPatchEvidence {
  filesChanged: string[];
  linesAdded: number;
  linesDeleted: number;
  diffSha256: string;
  forbiddenFiles: string[];
}

export interface CodingTaskScores {
  correctness: number;
  regressionSafety: number;
  patchScope: number;
  testQuality: number;
  efficiency: number;
  overall: number;
}

export interface CodingTaskResult {
  taskId: string;
  category: CodeTaskCategory;
  status: "pass" | "fail" | "executor-error";
  executorSuccess: boolean;
  executorOutputSha256: string;
  durationMs: number;
  checks: CodingCheckResult[];
  patch: CodingPatchEvidence;
  scores: CodingTaskScores;
  error: string | null;
}

export interface CodingFoldArtifactV1 {
  schema_version: 1;
  run: {
    run_id: string;
    benchmark: typeof CODE_BENCHMARK_NAME;
    timestamp: string;
    shadow_only: true;
  };
  cohort: {
    cohort_id: string;
    fold_index: number;
    fold_seed: number;
    minimum_folds: 5;
  };
  provenance: {
    produced_by: "zourobench-code";
    harness_version: string;
    corpus_version: string;
    manifest_sha256: string;
    git_commit: string;
    git_dirty: boolean | null;
  };
  execution: {
    model: string;
    executor: string;
    sandbox: "bubblewrap" | "fixture";
    timeout_ms: number;
    started_at: string;
    completed_at: string;
    duration_ms: number;
  };
  totals: {
    tasks: number;
    passed: number;
    failed: number;
  };
  scores: CodingTaskScores;
  tasks: CodingTaskResult[];
}

const CATEGORIES: CodeTaskCategory[] = [
  "bug-fix",
  "feature",
  "integration",
  "refactor",
  "test-creation",
];

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function manifestFingerprint(manifest: CodingCorpusManifest): string {
  return sha256(canonicalJson(manifest));
}

export function validateCodingManifest(manifest: CodingCorpusManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== CODE_BENCHMARK_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  if (manifest.benchmark !== CODE_BENCHMARK_NAME) errors.push(`benchmark must be ${CODE_BENCHMARK_NAME}`);
  if (manifest.policy !== "five-fold-typescript-bun-v1") errors.push("unsupported corpus policy");
  if (manifest.tasks.length !== 20) errors.push("corpus must contain exactly 20 tasks");
  const ids = new Set<string>();
  for (const task of manifest.tasks) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id)) errors.push(`${task.id}: invalid task id`);
    if (ids.has(task.id)) errors.push(`${task.id}: duplicate task id`);
    ids.add(task.id);
    if (!CODE_BENCHMARK_FOLDS.includes(task.fold as 1 | 2 | 3 | 4 | 5)) errors.push(`${task.id}: invalid fold`);
    if (!CATEGORIES.includes(task.category)) errors.push(`${task.id}: invalid category`);
    if (task.timeoutMs < 30_000 || task.timeoutMs > 900_000) errors.push(`${task.id}: timeout outside bounds`);
    if (task.requiredCommands.length < 2) errors.push(`${task.id}: requires typecheck and visible-test commands`);
    if (task.hiddenCommands.length < 3) errors.push(`${task.id}: requires at least three hidden checks`);
  }
  for (const fold of CODE_BENCHMARK_FOLDS) {
    if (manifest.tasks.filter((task) => task.fold === fold).length !== 4) errors.push(`fold ${fold}: expected four tasks`);
  }
  for (const category of CATEGORIES) {
    if (manifest.tasks.filter((task) => task.category === category).length !== 4) {
      errors.push(`${category}: expected four tasks`);
    }
  }
  return errors;
}

export function averageTaskScores(results: CodingTaskResult[]): CodingTaskScores {
  const average = (field: keyof Omit<CodingTaskScores, "overall">): number =>
    results.length ? results.reduce((sum, result) => sum + result.scores[field], 0) / results.length : 0;
  const scores = {
    correctness: average("correctness"),
    regressionSafety: average("regressionSafety"),
    patchScope: average("patchScope"),
    testQuality: average("testQuality"),
    efficiency: average("efficiency"),
  };
  return {
    ...scores,
    overall: scores.correctness + scores.regressionSafety + scores.patchScope + scores.testQuality + scores.efficiency,
  };
}
