/**
 * ZouroBench Results Explorer — path-safe read-only artifact store
 * (ZBRE-003 / ZOU-831).
 *
 * The stable server boundary between the immutable artifact files under
 * `packages/bench/data` and the explorer UI. The store only ever reads
 * direct children of configured allowlisted roots; it never writes, never
 * recurses, and never follows symlinks. Run artifacts are validated and
 * legacy-normalized through the ZBRE-001 contract — invalid artifacts are
 * listed with structured reasons and never included in aggregates.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import {
  aggregateArtifacts,
  normalizeResultArtifact,
  type AggregateResult,
  type ContractIssue,
  type NormalizedRun,
} from "../contracts/result-contract";

export type ArtifactKind = "runs" | "baselines" | "cohorts" | "parity";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["runs", "baselines", "cohorts", "parity"];

const DEFAULT_ROOTS: Record<ArtifactKind, string> = {
  runs: "runs",
  baselines: "baselines",
  cohorts: "cohorts",
  parity: "parity",
};

/**
 * Artifact ids and file names may not contain path separators, dot-prefixes,
 * or anything else that could reach the filesystem layer as a path fragment.
 */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeArtifactId(id: string): boolean {
  return id.length > 0 && id.length <= 255 && SAFE_ID.test(id);
}

export interface ExplorerStoreConfig {
  /** Absolute path of the data directory (canonically `packages/bench/data`). */
  dataRoot: string;
  /** Optional per-kind subdirectories, always resolved under `dataRoot`. */
  roots?: Partial<Record<ArtifactKind, string>>;
  /**
   * Fail-closed bound on directory entries per root (default 10 000). A root
   * exceeding it is served as empty with `overflow: true` — loud, never a
   * silent truncation — keeping per-request scan work strictly bounded.
   */
  maxFilesPerRoot?: number;
}

export interface InvalidArtifact {
  kind: ArtifactKind;
  id: string;
  file: string;
  reasons: ContractIssue[];
}

export interface RunSummary {
  id: string;
  file: string;
  schema_version: 1 | 2;
  benchmark: string;
  dataset: string;
  timestamp: string;
  run_id: string | null;
  totals: { total_questions: number; answered: number };
  overall_accuracy: number;
  size_bytes: number;
}

export interface LoadedRun {
  summary: RunSummary;
  run: NormalizedRun;
  warnings: ContractIssue[];
}

export interface BaselineEntry {
  id: string;
  file: string;
  timestamp: string;
  overall: number;
  categories: Record<string, number>;
  run_file: string | null;
}

/** Cohort and parity artifacts are v2-era kinds validated by field shape. */
export interface CohortEntry {
  id: string;
  file: string;
  cohort_id: string;
  replicate_index: number;
  replicate_seed: number;
  minimum_n: number;
  timeout_ms: number | null;
}

export interface ParityEntry {
  id: string;
  file: string;
  baseline_run_id: string;
  baseline_overall_accuracy: number;
  delta_overall_accuracy: number;
  paired_questions: number;
}

export interface RootStatus {
  kind: ArtifactKind;
  path: string;
  exists: boolean;
  /**
   * false when the root currently resolves outside the data root (e.g. it
   * was replaced by an escaping symlink after store construction) — the
   * root is then served as empty, fail-closed.
   */
  safe: boolean;
  /** true when the root exceeded maxFilesPerRoot and was served as empty. */
  overflow: boolean;
  file_count: number;
  invalid_count: number;
  ignored_entries: number;
}

export interface IndexStats {
  parsed_files: number;
  cached_files: number;
}

export interface StoreIndex {
  fingerprint: string;
  roots: RootStatus[];
  runs: Map<string, LoadedRun>;
  runOrder: string[];
  invalid: InvalidArtifact[];
  baselines: BaselineEntry[];
  cohorts: CohortEntry[];
  parity: ParityEntry[];
  stats: IndexStats;
}

export type ModelRosterStatus = "available" | "missing" | "invalid";

export interface ModelRosterEntry {
  canonical_model: string;
  family: string;
  aliases: string[];
  routes: string[];
  providers: string[];
  profiles: string[];
  roles: string[];
  lifecycle_status: string;
  route_health: string;
  benchmark_status: string;
  benchmark_eligible: boolean;
  benchmark_runnable: boolean;
}

export interface ModelRosterSnapshot {
  status: ModelRosterStatus;
  generated_at: string | null;
  policy: string | null;
  fingerprint: string | null;
  models: ModelRosterEntry[];
  unresolved_targets: string[];
  total_targets: number;
  reason: string | null;
}

interface ScannedFile {
  kind: ArtifactKind;
  name: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ScannedRoot {
  status: RootStatus;
  files: ScannedFile[];
  refused: InvalidArtifact[];
}

type ParsedEntry =
  | { kind: "runs"; loaded: LoadedRun | null; raw: unknown; invalid: InvalidArtifact | null }
  | { kind: "baselines"; entry: BaselineEntry | null; invalid: InvalidArtifact | null }
  | { kind: "cohorts"; entry: CohortEntry | null; invalid: InvalidArtifact | null }
  | { kind: "parity"; entry: ParityEntry | null; invalid: InvalidArtifact | null };

interface CacheSlot {
  signature: string;
  parsed: ParsedEntry;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unavailableModelRoster(
  status: Exclude<ModelRosterStatus, "available">,
  reason: string,
): ModelRosterSnapshot {
  return {
    status,
    generated_at: null,
    policy: null,
    fingerprint: null,
    models: [],
    unresolved_targets: [],
    total_targets: 0,
    reason,
  };
}

function parseModelRoster(raw: string): ModelRosterSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailableModelRoster("invalid", "model roster is not valid JSON");
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
    return unavailableModelRoster("invalid", "model roster schemaVersion must be 1");
  }
  if (
    typeof parsed.generatedAt !== "string" ||
    typeof parsed.policy !== "string" ||
    !Array.isArray(parsed.models) ||
    !isStringArray(parsed.unresolvedTargets)
  ) {
    return unavailableModelRoster("invalid", "model roster is missing required top-level fields");
  }

  const models: ModelRosterEntry[] = [];
  for (const value of parsed.models) {
    if (!isPlainObject(value)) {
      return unavailableModelRoster("invalid", "model roster contains a non-object model entry");
    }
    const requiredStrings = [
      "canonicalModel",
      "family",
      "lifecycleStatus",
      "routeHealth",
      "benchmarkStatus",
    ] as const;
    if (
      requiredStrings.some((key) => typeof value[key] !== "string") ||
      !isStringArray(value.routes) ||
      !isStringArray(value.providers) ||
      !isStringArray(value.profiles) ||
      !isStringArray(value.roles) ||
      typeof value.benchmarkEligible !== "boolean" ||
      typeof value.benchmarkRunnable !== "boolean"
    ) {
      return unavailableModelRoster("invalid", "model roster contains an invalid model entry");
    }
    const evidenceIds = isPlainObject(value.benchmarkEvidence) &&
      isStringArray(value.benchmarkEvidence.sourceModelIds)
      ? value.benchmarkEvidence.sourceModelIds
      : [];
    const canonicalModel = value.canonicalModel as string;
    models.push({
      canonical_model: canonicalModel,
      family: value.family as string,
      aliases: [...new Set([canonicalModel, ...value.routes, ...evidenceIds])],
      routes: value.routes,
      providers: value.providers,
      profiles: value.profiles,
      roles: value.roles,
      lifecycle_status: value.lifecycleStatus as string,
      route_health: value.routeHealth as string,
      benchmark_status: value.benchmarkStatus as string,
      benchmark_eligible: value.benchmarkEligible,
      benchmark_runnable: value.benchmarkRunnable,
    });
  }

  const unresolvedTargets = [...new Set(parsed.unresolvedTargets)].sort();
  return {
    status: "available",
    generated_at: parsed.generatedAt,
    policy: parsed.policy,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    models,
    unresolved_targets: unresolvedTargets,
    total_targets: models.length + unresolvedTargets.length,
    reason: null,
  };
}

function issue(path: string, code: ContractIssue["code"], message: string): ContractIssue {
  return { path, code, message };
}

function idOf(fileName: string): string {
  return fileName.replace(/\.json$/, "");
}

/** `child` must equal `parent` or live strictly inside it. */
function isContainedIn(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export class ArtifactStore {
  private readonly dataRoot: string;
  private readonly rootPaths: Record<ArtifactKind, string>;
  private readonly maxFilesPerRoot: number;
  private readonly cache = new Map<string, CacheSlot>();
  private lastIndex: StoreIndex | null = null;
  private aggregateCache: { fingerprint: string; aggregate: AggregateResult } | null = null;

  constructor(config: ExplorerStoreConfig) {
    const dataRoot = resolve(config.dataRoot);
    if (!existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
      throw new Error(`explorer store dataRoot is not a directory: ${dataRoot}`);
    }
    this.dataRoot = realpathSync(dataRoot);
    const maxFiles = config.maxFilesPerRoot ?? 10_000;
    if (!Number.isInteger(maxFiles) || maxFiles < 1) {
      throw new Error(`explorer store maxFilesPerRoot must be a positive integer: ${maxFiles}`);
    }
    this.maxFilesPerRoot = maxFiles;

    const rootPaths = {} as Record<ArtifactKind, string>;
    for (const kind of ARTIFACT_KINDS) {
      const sub = config.roots?.[kind] ?? DEFAULT_ROOTS[kind];
      const candidate = resolve(this.dataRoot, sub);
      if (!isContainedIn(this.dataRoot, candidate)) {
        throw new Error(
          `explorer store root "${kind}" escapes dataRoot: ${JSON.stringify(sub)} resolves outside ${this.dataRoot}`,
        );
      }
      if (existsSync(candidate)) {
        const real = realpathSync(candidate);
        if (!isContainedIn(this.dataRoot, real)) {
          throw new Error(
            `explorer store root "${kind}" is a link escaping dataRoot: ${candidate} -> ${real}`,
          );
        }
      }
      rootPaths[kind] = candidate;
    }
    this.rootPaths = rootPaths;
  }

  /** Relative (root-kind → subpath) view for health reporting. */
  rootPath(kind: ArtifactKind): string {
    return this.rootPaths[kind];
  }

  /**
   * Deterministic index access. Every call re-scans directory listings and
   * stats — a deliberate tradeoff: no TTLs or wall-clock heuristics, so the
   * served index can never be stale relative to disk. The per-request cost
   * is O(direct children) stat calls (measured ~60 ms cold / ~6 ms warm at
   * the 500-run acceptance fixture; the 2 s budget bounds it); files are
   * re-parsed only when their `(size, mtimeMs, ctimeMs)` signature changed.
   * Same disk state ⇒ same fingerprint ⇒ same index.
   */
  getIndex(): StoreIndex {
    const scanned = ARTIFACT_KINDS.map((kind) => this.scanRoot(kind));
    const fingerprint = this.fingerprintOf(scanned);
    if (this.lastIndex && this.lastIndex.fingerprint === fingerprint) {
      return this.lastIndex;
    }

    const stats: IndexStats = { parsed_files: 0, cached_files: 0 };
    const runs = new Map<string, LoadedRun>();
    const invalid: InvalidArtifact[] = [];
    const baselines: BaselineEntry[] = [];
    const cohorts: CohortEntry[] = [];
    const parity: ParityEntry[] = [];
    const liveKeys = new Set<string>();

    for (const root of scanned) {
      invalid.push(...root.refused);
      for (const file of root.files) {
        const cacheKey = `${file.kind} ${file.name}`;
        liveKeys.add(cacheKey);
        const signature = `${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
        let slot = this.cache.get(cacheKey);
        if (slot && slot.signature === signature) {
          stats.cached_files += 1;
        } else {
          slot = { signature, parsed: this.parseFile(file) };
          this.cache.set(cacheKey, slot);
          stats.parsed_files += 1;
        }
        const parsed = slot.parsed;
        if (parsed.kind === "runs") {
          if (parsed.loaded) runs.set(parsed.loaded.summary.id, parsed.loaded);
          if (parsed.invalid) invalid.push(parsed.invalid);
        } else if (parsed.kind === "baselines") {
          if (parsed.entry) baselines.push(parsed.entry);
          if (parsed.invalid) invalid.push(parsed.invalid);
        } else if (parsed.kind === "cohorts") {
          if (parsed.entry) cohorts.push(parsed.entry);
          if (parsed.invalid) invalid.push(parsed.invalid);
        } else {
          if (parsed.entry) parity.push(parsed.entry);
          if (parsed.invalid) invalid.push(parsed.invalid);
        }
      }
    }
    for (const key of this.cache.keys()) {
      if (!liveKeys.has(key)) this.cache.delete(key);
    }

    // Chronological (epoch) ordering so ISO timestamps with different UTC
    // offsets sort correctly; unparseable timestamps sort last, then by the
    // raw string and id so the order stays fully deterministic.
    const runOrder = [...runs.values()]
      .sort((a, b) => {
        const ta = Date.parse(a.summary.timestamp);
        const tb = Date.parse(b.summary.timestamp);
        const va = Number.isFinite(ta);
        const vb = Number.isFinite(tb);
        if (va && vb && ta !== tb) return tb - ta;
        if (va !== vb) return va ? -1 : 1;
        return (
          b.summary.timestamp.localeCompare(a.summary.timestamp) ||
          a.summary.id.localeCompare(b.summary.id)
        );
      })
      .map((r) => r.summary.id);
    baselines.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
    cohorts.sort((a, b) => a.id.localeCompare(b.id));
    parity.sort((a, b) => a.id.localeCompare(b.id));
    invalid.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

    const roots = scanned.map((root) => ({
      ...root.status,
      invalid_count: invalid.filter((entry) => entry.kind === root.status.kind).length,
    }));

    this.lastIndex = { fingerprint, roots, runs, runOrder, invalid, baselines, cohorts, parity, stats };
    return this.lastIndex;
  }

  /** Index-map-only lookup; ids never touch the filesystem layer. */
  getRun(id: string): LoadedRun | undefined {
    if (!isSafeArtifactId(id)) return undefined;
    return this.getIndex().runs.get(id);
  }

  /**
   * Aggregate over every readable run-root artifact via the contract's
   * `aggregateArtifacts` — invalid artifacts surface as structured
   * exclusions and never contribute to totals. Refused entries (symlinks,
   * escaping paths) were never read, so they cannot appear in the input at
   * all. Cached per index fingerprint.
   */
  getAggregate(): AggregateResult {
    const index = this.getIndex();
    if (this.aggregateCache && this.aggregateCache.fingerprint === index.fingerprint) {
      return this.aggregateCache.aggregate;
    }
    const items: Array<{ key: string; raw: unknown }> = [];
    const pushSlot = (cacheKey: string, key: string) => {
      const slot = this.cache.get(cacheKey);
      if (slot && slot.parsed.kind === "runs") items.push({ key, raw: slot.parsed.raw });
    };
    for (const id of index.runOrder) pushSlot(`runs ${id}.json`, id);
    for (const entry of index.invalid) {
      if (entry.kind === "runs") pushSlot(`runs ${entry.file}`, entry.id);
    }
    const aggregate = aggregateArtifacts(items);
    this.aggregateCache = { fingerprint: index.fingerprint, aggregate };
    return aggregate;
  }

  getModelRoster(): ModelRosterSnapshot {
    const rosterDir = resolve(this.dataRoot, "zourobench");
    const rosterPath = resolve(rosterDir, "lineup-model-roster.json");
    if (!existsSync(rosterPath)) {
      return unavailableModelRoster("missing", "model roster artifact is not present");
    }
    try {
      if (
        (existsSync(rosterDir) && lstatSync(rosterDir).isSymbolicLink()) ||
        lstatSync(rosterPath).isSymbolicLink()
      ) {
        return unavailableModelRoster("invalid", "model roster symlinks are refused");
      }
      const realPath = realpathSync(rosterPath);
      if (!isContainedIn(this.dataRoot, realPath)) {
        return unavailableModelRoster("invalid", "model roster resolves outside the data root");
      }
      const stat = statSync(realPath);
      if (!stat.isFile() || stat.size > 1_000_000) {
        return unavailableModelRoster("invalid", "model roster must be a regular file no larger than 1 MB");
      }
      return parseModelRoster(readFileSync(realPath, "utf8"));
    } catch (error) {
      return unavailableModelRoster(
        "invalid",
        error instanceof Error ? error.message : "model roster could not be read",
      );
    }
  }

  // ── Scanning ──────────────────────────────────────────────────────

  private scanRoot(kind: ArtifactKind): ScannedRoot {
    const rootPath = this.rootPaths[kind];
    const status: RootStatus = {
      kind,
      path: rootPath,
      exists: false,
      safe: true,
      overflow: false,
      file_count: 0,
      invalid_count: 0,
      ignored_entries: 0,
    };
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      return { status, files: [], refused: [] };
    }
    status.exists = true;
    // Re-verify containment on every scan, not just at construction: if the
    // root was since replaced by a symlink escaping the data root, fail
    // closed and serve the root as empty rather than indexing foreign files.
    const realRoot = realpathSync(rootPath);
    if (!isContainedIn(this.dataRoot, realRoot)) {
      status.safe = false;
      return { status, files: [], refused: [] };
    }
    const files: ScannedFile[] = [];
    const refused: InvalidArtifact[] = [];
    const entries = readdirSync(rootPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (entries.length > this.maxFilesPerRoot) {
      status.overflow = true;
      return { status, files: [], refused: [] };
    }
    for (const entry of entries) {
      if (!SAFE_FILE_NAME.test(entry.name)) {
        status.ignored_entries += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        refused.push({
          kind,
          id: idOf(entry.name),
          file: entry.name,
          reasons: [
            issue("$", "invalid_value", "symlink refused: allowlisted roots serve regular files only"),
          ],
        });
        continue;
      }
      if (!entry.isFile()) {
        status.ignored_entries += 1;
        continue;
      }
      const absPath = resolve(rootPath, entry.name);
      let real: string;
      try {
        real = realpathSync(absPath);
      } catch {
        status.ignored_entries += 1;
        continue;
      }
      if (!isContainedIn(realRoot, real)) {
        refused.push({
          kind,
          id: idOf(entry.name),
          file: entry.name,
          reasons: [issue("$", "invalid_value", "path escapes the allowlisted root")],
        });
        continue;
      }
      const stat = statSync(absPath);
      status.file_count += 1;
      files.push({
        kind,
        name: entry.name,
        absPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    }
    return { status, files, refused };
  }

  private fingerprintOf(scanned: ScannedRoot[]): string {
    const hash = createHash("sha256");
    for (const root of scanned) {
      hash.update(
        `${root.status.kind} ${root.status.exists ? 1 : 0} ${root.status.safe ? 1 : 0} ${root.status.overflow ? 1 : 0}\n`,
      );
      for (const file of root.files) {
        // ctimeMs is included so a content rewrite that preserves size and
        // restores mtime still invalidates deterministically.
        hash.update(`${root.status.kind} ${file.name} ${file.size} ${file.mtimeMs} ${file.ctimeMs}\n`);
      }
      for (const refusedEntry of root.refused) {
        hash.update(`${root.status.kind} refused ${refusedEntry.file}\n`);
      }
    }
    return hash.digest("hex");
  }

  // ── Parsing / validation ──────────────────────────────────────────

  private parseFile(file: ScannedFile): ParsedEntry {
    const id = idOf(file.name);
    const fail = (code: ContractIssue["code"], message: string): ParsedEntry => {
      const invalid: InvalidArtifact = {
        kind: file.kind,
        id,
        file: file.name,
        reasons: [issue("$", code, message)],
      };
      if (file.kind === "runs") return { kind: "runs", loaded: null, raw: null, invalid };
      return { kind: file.kind, entry: null, invalid } as ParsedEntry;
    };

    // Open with O_NOFOLLOW and re-verify the open fd is a regular file: even
    // if the entry is swapped for a symlink between the scan's lstat and this
    // read, the open fails closed instead of following the link.
    let text: string;
    try {
      const fd = openSync(file.absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile()) {
          return fail("invalid_value", "refused at open: not a regular file");
        }
        // Verify what the open actually resolved to (guards a concurrent
        // parent-directory symlink swap): the kernel's view of the fd must
        // still live under the data root. Falls back to a realpath re-check
        // where /proc is unavailable.
        let resolved: string;
        try {
          resolved = readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          resolved = realpathSync(file.absPath);
        }
        if (!isContainedIn(this.dataRoot, resolved)) {
          return fail("invalid_value", "refused at open: resolved path escapes the data root");
        }
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return fail(
        "invalid_value",
        `refused at open (symlink or unreadable): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return fail(
        "not_object",
        `file is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    switch (file.kind) {
      case "runs":
        return this.parseRun(file, id, raw);
      case "baselines":
        return { kind: "baselines", ...this.parseBaseline(file, id, raw) };
      case "cohorts":
        return { kind: "cohorts", ...this.parseCohort(file, id, raw) };
      case "parity":
        return { kind: "parity", ...this.parseParity(file, id, raw) };
    }
  }

  private parseRun(file: ScannedFile, id: string, raw: unknown): ParsedEntry {
    const result = normalizeResultArtifact(raw);
    if (!result.ok) {
      return {
        kind: "runs",
        loaded: null,
        raw,
        invalid: { kind: "runs", id, file: file.name, reasons: result.errors },
      };
    }
    const run = result.run;
    const summary: RunSummary = {
      id,
      file: file.name,
      schema_version: run.schema_version,
      benchmark: run.benchmark,
      dataset: run.dataset,
      timestamp: run.timestamp,
      run_id: run.run_id.value,
      totals: run.totals,
      overall_accuracy: run.scores.overall_accuracy,
      size_bytes: file.size,
    };
    return {
      kind: "runs",
      loaded: { summary, run, warnings: result.warnings },
      raw,
      invalid: null,
    };
  }

  private parseBaseline(
    file: ScannedFile,
    id: string,
    raw: unknown,
  ): { entry: BaselineEntry | null; invalid: InvalidArtifact | null } {
    const reasons: ContractIssue[] = [];
    if (!isPlainObject(raw)) {
      reasons.push(issue("$", "not_object", "baseline artifact is not a JSON object"));
    } else {
      if (typeof raw.timestamp !== "string" || raw.timestamp.length === 0) {
        reasons.push(issue("$.timestamp", "missing_field", "required string field is missing"));
      }
      if (!isPlainObject(raw.scores)) {
        reasons.push(issue("$.scores", "missing_field", "required object field is missing"));
      } else if (typeof raw.scores.overall !== "number" || !Number.isFinite(raw.scores.overall)) {
        reasons.push(issue("$.scores.overall", "wrong_type", "expected finite number"));
      } else {
        for (const [name, value] of Object.entries(raw.scores)) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            reasons.push(issue(`$.scores.${name}`, "wrong_type", "expected finite number"));
          }
        }
      }
    }
    if (reasons.length > 0 || !isPlainObject(raw)) {
      return { entry: null, invalid: { kind: "baselines", id, file: file.name, reasons } };
    }
    const scores = raw.scores as Record<string, number>;
    const { overall, ...categories } = scores;
    return {
      entry: {
        id,
        file: file.name,
        timestamp: raw.timestamp as string,
        overall,
        categories,
        run_file: typeof raw.run_file === "string" ? raw.run_file : null,
      },
      invalid: null,
    };
  }

  private parseCohort(
    file: ScannedFile,
    id: string,
    raw: unknown,
  ): { entry: CohortEntry | null; invalid: InvalidArtifact | null } {
    const reasons: ContractIssue[] = [];
    let entry: CohortEntry | null = null;
    if (!isPlainObject(raw)) {
      reasons.push(issue("$", "not_object", "cohort artifact is not a JSON object"));
    } else {
      const cohortId = typeof raw.cohort_id === "string" && raw.cohort_id ? raw.cohort_id : null;
      if (!cohortId) reasons.push(issue("$.cohort_id", "missing_field", "required string field is missing"));
      for (const key of ["replicate_index", "replicate_seed", "minimum_n"] as const) {
        if (typeof raw[key] !== "number" || !Number.isFinite(raw[key] as number)) {
          reasons.push(issue(`$.${key}`, "missing_field", "required number field is missing"));
        }
      }
      const timeout = raw.timeout_ms;
      if (timeout !== null && (typeof timeout !== "number" || !Number.isFinite(timeout))) {
        reasons.push(issue("$.timeout_ms", "wrong_type", "expected number or null"));
      }
      if (reasons.length === 0) {
        entry = {
          id,
          file: file.name,
          cohort_id: cohortId as string,
          replicate_index: raw.replicate_index as number,
          replicate_seed: raw.replicate_seed as number,
          minimum_n: raw.minimum_n as number,
          timeout_ms: timeout as number | null,
        };
      }
    }
    if (!entry) return { entry: null, invalid: { kind: "cohorts", id, file: file.name, reasons } };
    return { entry, invalid: null };
  }

  private parseParity(
    file: ScannedFile,
    id: string,
    raw: unknown,
  ): { entry: ParityEntry | null; invalid: InvalidArtifact | null } {
    const reasons: ContractIssue[] = [];
    let entry: ParityEntry | null = null;
    if (!isPlainObject(raw)) {
      reasons.push(issue("$", "not_object", "parity artifact is not a JSON object"));
    } else {
      const baselineRunId =
        typeof raw.baseline_run_id === "string" && raw.baseline_run_id ? raw.baseline_run_id : null;
      if (!baselineRunId) {
        reasons.push(issue("$.baseline_run_id", "missing_field", "required string field is missing"));
      }
      for (const key of [
        "baseline_overall_accuracy",
        "delta_overall_accuracy",
        "paired_questions",
      ] as const) {
        if (typeof raw[key] !== "number" || !Number.isFinite(raw[key] as number)) {
          reasons.push(issue(`$.${key}`, "missing_field", "required number field is missing"));
        }
      }
      if (reasons.length === 0) {
        entry = {
          id,
          file: file.name,
          baseline_run_id: baselineRunId as string,
          baseline_overall_accuracy: raw.baseline_overall_accuracy as number,
          delta_overall_accuracy: raw.delta_overall_accuracy as number,
          paired_questions: raw.paired_questions as number,
        };
      }
    }
    if (!entry) return { entry: null, invalid: { kind: "parity", id, file: file.name, reasons } };
    return { entry, invalid: null };
  }
}

export function createArtifactStore(config: ExplorerStoreConfig): ArtifactStore {
  return new ArtifactStore(config);
}
