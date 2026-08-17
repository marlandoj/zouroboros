import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureExecutionBaseCommit, type ProvenanceGitRunner } from "./execution-provenance";

const SHA = "1".repeat(40);

function withState(run: (stateDir: string) => void): void {
  const stateDir = mkdtempSync(join(tmpdir(), "execution-provenance-"));
  try {
    run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("execution provenance repository identity", () => {
  test("accepts an isolated worktree from the recorded repository", () => {
    withState((stateDir) => {
      writeFileSync(
        join(stateDir, "exec-exec-live.json"),
        JSON.stringify({ base_commit: SHA, repo_path: "/repo/canonical" }),
      );
      const git: ProvenanceGitRunner = (args) => {
        expect(args).toEqual(["rev-parse", "--git-common-dir"]);
        return "/repo/canonical/.git";
      };
      expect(captureExecutionBaseCommit({
        executionId: "exec-live",
        stateDir,
        workdir: "/repo/worktrees/ticket",
        git,
      })).toBe(SHA);
    });
  });

  test("rejects a different repository even when the commit hash is valid", () => {
    withState((stateDir) => {
      writeFileSync(
        join(stateDir, "exec-exec-live.json"),
        JSON.stringify({ base_commit: SHA, repo_path: "/repo/canonical" }),
      );
      const git: ProvenanceGitRunner = (_args, cwd) => `${cwd}/.git`;
      expect(() => captureExecutionBaseCommit({
        executionId: "exec-live",
        stateDir,
        workdir: "/other/clone",
        git,
      })).toThrow("execution provenance repository mismatch");
    });
  });

  test("captures the requested ref when no durable base exists", () => {
    withState((stateDir) => {
      const git: ProvenanceGitRunner = (args) => {
        expect(args).toEqual(["rev-parse", "origin/main"]);
        return SHA.toUpperCase();
      };
      expect(captureExecutionBaseCommit({
        executionId: "exec-new",
        stateDir,
        workdir: "/repo/worktrees/new",
        ref: "origin/main",
        git,
      })).toBe(SHA);
    });
  });
});
