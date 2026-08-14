#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = "/home/workspace";
const DEFAULT_IGNORE_FILE = path.join(WORKSPACE_ROOT, ".ignore");
const DEFAULT_LOG_FILE = "/dev/shm/workspace-search.jsonl";
const REQUIRED_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.pnpm-store/**",
  "**/.yarn/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/venv/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/.nyc_output/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/.cache/**",
  "**/.codebase-memory/**",
];

type SearchKind = "content" | "filename";
type SearchStatus = "completed" | "truncated" | "timeout" | "error";

interface Options {
  root: string;
  query: string;
  kind: SearchKind;
  include?: string;
  excludes: string[];
  regex: boolean;
  ignoreCase: boolean;
  timeoutMs: number;
  maxResults: number;
  logFile?: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stderr: string;
}

interface SearchMatch {
  path: string;
  line?: number;
  column?: number;
  text?: string;
}

function usage(): string {
  return `Usage:
  workspace-search.ts --root <directory> --query <pattern> [options]

Required:
  --root <directory>       Concrete search root inside /home/workspace
  --query <pattern>        Literal text by default

Options:
  --kind <content|filename>  Search mode (default: content)
  --include <glob>           Include glob relative to root
  --exclude <glob>           Additional exclusion; repeatable
  --regex                    Treat query as a regular expression
  --ignore-case              Case-insensitive matching
  --timeout-ms <number>      Total deadline (default: 30000)
  --max-results <number>     Global result cap (default: 200)
  --log-file <path>          Telemetry JSONL path (default: /dev/shm/workspace-search.jsonl)
  --no-log                   Disable telemetry logging
  --help                     Show this help`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  let root = "";
  let query = "";
  let kind: SearchKind = "content";
  let include: string | undefined;
  const excludes: string[] = [];
  let regex = false;
  let ignoreCase = false;
  let timeoutMs = 30_000;
  let maxResults = 200;
  let logFile: string | undefined = DEFAULT_LOG_FILE;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    switch (flag) {
      case "--root":
        root = requireValue(argv, index, flag);
        index++;
        break;
      case "--query":
        query = requireValue(argv, index, flag);
        index++;
        break;
      case "--kind": {
        const value = requireValue(argv, index, flag);
        if (value !== "content" && value !== "filename") {
          throw new Error("--kind must be content or filename");
        }
        kind = value;
        index++;
        break;
      }
      case "--include":
        include = requireValue(argv, index, flag);
        index++;
        break;
      case "--exclude":
        excludes.push(requireValue(argv, index, flag));
        index++;
        break;
      case "--regex":
        regex = true;
        break;
      case "--ignore-case":
        ignoreCase = true;
        break;
      case "--timeout-ms":
        timeoutMs = parsePositiveInteger(requireValue(argv, index, flag), flag);
        index++;
        break;
      case "--max-results":
        maxResults = parsePositiveInteger(requireValue(argv, index, flag), flag);
        index++;
        break;
      case "--log-file":
        logFile = requireValue(argv, index, flag);
        index++;
        break;
      case "--no-log":
        logFile = undefined;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!root) {
    throw new Error("--root is required");
  }
  if (!query) {
    throw new Error("--query is required");
  }
  if (timeoutMs > 120_000) {
    throw new Error("--timeout-ms cannot exceed 120000");
  }
  if (maxResults > 5_000) {
    throw new Error("--max-results cannot exceed 5000");
  }

  return {
    root,
    query,
    kind,
    include,
    excludes,
    regex,
    ignoreCase,
    timeoutMs,
    maxResults,
    logFile,
  };
}

async function validateRoot(requestedRoot: string): Promise<string> {
  const resolved = await realpath(path.resolve(requestedRoot));
  const workspacePrefix = `${WORKSPACE_ROOT}${path.sep}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(workspacePrefix)) {
    throw new Error(`Search root must resolve inside ${WORKSPACE_ROOT}`);
  }
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new Error("Search root must be a directory");
  }
  return resolved;
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function runProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLine: (line: string) => boolean,
): Promise<ProcessResult> {
  const startedAt = performance.now();
  const child = spawn("rg", args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderr = "";
  let timedOut = false;
  let truncated = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: "timeout" | "truncated") => {
    if (reason === "timeout") {
      timedOut = true;
    } else {
      truncated = true;
    }
    terminateProcessGroup(child, "SIGTERM");
    forceKillTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 1_000);
  };

  const timeout = setTimeout(() => stop("timeout"), timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line && !onLine(line) && !truncated && !timedOut) {
        stop("truncated");
        break;
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) {
      stderr += chunk.slice(0, 16_384 - stderr.length);
    }
  });

  const result = await new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (stdoutBuffer && !truncated && !timedOut) {
        onLine(stdoutBuffer);
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        truncated,
        durationMs: Math.round(performance.now() - startedAt),
        stderr: stderr.trim(),
      });
    });
  });

  return result;
}

function commonRgArgs(options: Options): string[] {
  const args: string[] = [];
  if (existsSync(DEFAULT_IGNORE_FILE)) {
    args.push("--ignore-file", DEFAULT_IGNORE_FILE);
  }
  for (const exclude of REQUIRED_EXCLUDES) {
    args.push("--glob", `!${exclude}`);
  }
  if (options.include) {
    args.push("--glob", options.include);
  }
  for (const exclude of options.excludes) {
    args.push("--glob", `!${exclude}`);
  }
  return args;
}

async function enumerateFiles(
  options: Options,
  root: string,
  remainingMs: number,
): Promise<{ count: number; process: ProcessResult }> {
  let count = 0;
  const args = [...commonRgArgs(options), "--files", "."];
  const processResult = await runProcess(args, root, remainingMs, () => {
    count++;
    return true;
  });
  return { count, process: processResult };
}

function makeFilenameMatcher(options: Options): (candidate: string) => boolean {
  if (options.regex) {
    const expression = new RegExp(options.query, options.ignoreCase ? "i" : undefined);
    return (candidate) => expression.test(candidate);
  }
  const query = options.ignoreCase ? options.query.toLowerCase() : options.query;
  return (candidate) => {
    const normalized = options.ignoreCase ? candidate.toLowerCase() : candidate;
    return normalized.includes(query);
  };
}

async function searchFilenames(
  options: Options,
  root: string,
  remainingMs: number,
): Promise<{
  results: SearchMatch[];
  enumeratedFiles: number;
  process: ProcessResult;
}> {
  const results: SearchMatch[] = [];
  let enumeratedFiles = 0;
  const matches = makeFilenameMatcher(options);
  const args = [...commonRgArgs(options), "--files", "."];
  const processResult = await runProcess(args, root, remainingMs, (line) => {
    enumeratedFiles++;
    if (matches(line)) {
      results.push({ path: line.replace(/^\.\//, "") });
    }
    return results.length < options.maxResults;
  });
  return { results, enumeratedFiles, process: processResult };
}

async function searchContent(
  options: Options,
  root: string,
  remainingMs: number,
): Promise<{
  results: SearchMatch[];
  matchedFiles?: number;
  process: ProcessResult;
}> {
  const results: SearchMatch[] = [];
  let matchedFiles: number | undefined;
  const args = [...commonRgArgs(options), "--json", "--color", "never", "--max-columns", "1000"];
  if (!options.regex) {
    args.push("--fixed-strings");
  }
  if (options.ignoreCase) {
    args.push("--ignore-case");
  }
  args.push("--", options.query, ".");

  const processResult = await runProcess(args, root, remainingMs, (line) => {
    try {
      const record = JSON.parse(line);
      if (record.type === "match") {
        const firstSubmatch = record.data?.submatches?.[0];
        results.push({
          path: String(record.data?.path?.text ?? "").replace(/^\.\//, ""),
          line: Number(record.data?.line_number ?? 0) || undefined,
          column:
            typeof firstSubmatch?.start === "number" ? firstSubmatch.start + 1 : undefined,
          text: String(record.data?.lines?.text ?? "").replace(/\r?\n$/, ""),
        });
      } else if (record.type === "summary") {
        const searchesWithMatch = record.data?.stats?.searches_with_match;
        if (typeof searchesWithMatch === "number") {
          matchedFiles = searchesWithMatch;
        }
      }
    } catch {
      return true;
    }
    return results.length < options.maxResults;
  });

  return { results, matchedFiles, process: processResult };
}

function deriveStatus(processResult: ProcessResult): SearchStatus {
  if (processResult.timedOut) {
    return "timeout";
  }
  if (processResult.truncated) {
    return "truncated";
  }
  if (processResult.exitCode === 0 || processResult.exitCode === 1) {
    return "completed";
  }
  return "error";
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  let root: string;
  try {
    root = await validateRoot(options.root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const phaseMs: Record<string, number> = {};
  let enumeratedFiles: number | undefined;
  let matchedFiles: number | undefined;
  let results: SearchMatch[] = [];
  let processResult: ProcessResult;

  if (options.kind === "filename") {
    const searchStarted = performance.now();
    const outcome = await searchFilenames(options, root, options.timeoutMs);
    phaseMs.search = Math.round(performance.now() - searchStarted);
    results = outcome.results;
    enumeratedFiles = outcome.enumeratedFiles;
    processResult = outcome.process;
  } else {
    const enumerationStarted = performance.now();
    const enumeration = await enumerateFiles(options, root, options.timeoutMs);
    phaseMs.enumeration = Math.round(performance.now() - enumerationStarted);
    enumeratedFiles = enumeration.count;

    if (enumeration.process.timedOut) {
      processResult = enumeration.process;
    } else {
      const elapsed = Date.now() - startedAt;
      const remainingMs = Math.max(1, options.timeoutMs - elapsed);
      const searchStarted = performance.now();
      const outcome = await searchContent(options, root, remainingMs);
      phaseMs.search = Math.round(performance.now() - searchStarted);
      results = outcome.results;
      matchedFiles = outcome.matchedFiles;
      processResult = outcome.process;
    }
  }

  const status = deriveStatus(processResult);
  const scannedFiles =
    options.kind === "content" && status === "completed" ? enumeratedFiles : undefined;
  const durationMs = Date.now() - startedAt;
  const output = {
    status,
    partial: status === "timeout" || status === "truncated",
    query: options.query,
    kind: options.kind,
    root,
    include: options.include ?? null,
    excludes: options.excludes,
    timeout_ms: options.timeoutMs,
    max_results: options.maxResults,
    results,
    telemetry: {
      started_at: new Date(startedAt).toISOString(),
      duration_ms: durationMs,
      phase_ms: phaseMs,
      enumerated_files: enumeratedFiles ?? null,
      scanned_files: scannedFiles ?? null,
      matched_files: matchedFiles ?? null,
      result_count: results.length,
      exit_code: processResult.exitCode,
      signal: processResult.signal,
      stderr: processResult.stderr || null,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  if (options.logFile) {
    const telemetryRecord = {
      timestamp: new Date().toISOString(),
      status,
      partial: output.partial,
      query_sha256: createHash("sha256").update(options.query).digest("hex"),
      query_length: options.query.length,
      kind: options.kind,
      root,
      include: options.include ?? null,
      excludes: options.excludes,
      timeout_ms: options.timeoutMs,
      max_results: options.maxResults,
      ...output.telemetry,
    };
    try {
      await appendFile(options.logFile, `${JSON.stringify(telemetryRecord)}\n`, "utf8");
    } catch (error) {
      console.error(`Telemetry log failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (status === "timeout") {
    process.exitCode = 124;
  } else if (status === "error") {
    process.exitCode = 2;
  }
}

await main();
