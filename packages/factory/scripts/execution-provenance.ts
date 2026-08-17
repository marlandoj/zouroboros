import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface ProvenanceGitRunner {
  (args: string[], cwd: string): string;
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout.trim();
}

function gitCommonDir(cwd: string, git: ProvenanceGitRunner): string {
  const raw = git(["rev-parse", "--git-common-dir"], cwd).trim();
  if (!raw) throw new Error(`unable to resolve Git common directory for ${cwd}`);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isSameRepository(recordedRepo: string, workdir: string, git: ProvenanceGitRunner): boolean {
  if (resolve(recordedRepo) === resolve(workdir)) return true;
  try {
    return gitCommonDir(recordedRepo, git) === gitCommonDir(workdir, git);
  } catch {
    return false;
  }
}

export function captureExecutionBaseCommit(input: {
  executionId: string;
  stateDir: string;
  workdir: string;
  ref?: string;
  git?: ProvenanceGitRunner;
}): string {
  const recordPath = join(input.stateDir, `exec-${input.executionId}.json`);
  const git = input.git ?? runGit;
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { base_commit?: unknown; repo_path?: unknown };
    if (typeof record.base_commit === "string" && FULL_SHA.test(record.base_commit)) {
      const recordedRepo = typeof record.repo_path === "string" ? record.repo_path : "/home/workspace";
      if (!isSameRepository(recordedRepo, input.workdir, git)) {
        throw new Error(`execution provenance repository mismatch: recorded ${recordedRepo}, resolved ${input.workdir}`);
      }
      return record.base_commit;
    }
  }

  const ref = input.ref ?? "HEAD";
  const sha = git(["rev-parse", ref], input.workdir).trim().toLowerCase();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`unable to capture a valid pre-execution base commit: ${sha || "empty git output"}`);
  }
  return sha;
}
