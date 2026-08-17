import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { receiptShadowExternalConfigHash, type ReceiptShadowExternalConfig } from "./runtime-config";
import { buildReceiptShadowReport } from "./run-receipt-shadow-report";
import { createExecutionLifecycle, transitionExecutionLifecycle } from "./execution-lifecycle";
import {
  buildPullRequestTitle,
  isAutoMergeUnavailable,
  loadShippingAttempt,
  MAX_PULL_REQUEST_TITLE_LENGTH,
  queueOrMergeNow,
  queueShippingRequest,
  runPrePrChangeQuiz,
  runReadyQueue,
  runShippingRequest,
  shipExecution,
  type CommandRunner,
  type Shipper,
  type ShippingExecution,
} from "./ship-ready-runner";

const directories: string[] = [];
const firstTimestamp = "2026-07-26T10:10:15.667Z";
const secondTimestamp = "2026-07-26T10:11:15.667Z";

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function shadowEnvironment(stateDir: string, dbPath: string, registryPath: string): Record<string, string> {
  const policyPath = join(stateDir, "shadow-policy.json");
  const configPath = join(stateDir, "shadow-config.json");
  writeFileSync(policyPath, readFileSync(join(import.meta.dir, "../../../Skills/zouroboros-governance/config/autonomy-policy.json")));
  const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const config: ReceiptShadowExternalConfig = {
    contract_id: "zouroboros-run-receipt-shadow-config/v1",
    version: 1,
    updated_at: firstTimestamp,
    updated_by: "test",
    mode: "shadow",
    activation_manifest_sha256: "a".repeat(64),
    effective_config_sha256: "0".repeat(64),
    automation_id: "7760679f-6ac8-461c-a567-43fae21c3eee",
    runtime: "zo-native",
    policy_path: policyPath,
    policy_sha256: fileHash(policyPath),
    database_path: dbPath,
    registry_path: registryPath,
    registry_sha256: fileHash(registryPath),
    cohort_amendment_sha256: "b".repeat(64),
    qualification_window_days: 225,
    required_operations_per_class: 30,
    max_plans_per_harvest: 12,
    max_database_bytes: 64 * 1024 * 1024,
    write_high_water_bytes: 56 * 1024 * 1024,
    github_readback_enabled: true,
  };
  config.effective_config_sha256 = receiptShadowExternalConfigHash(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    NODE_ENV: "test",
    FACTORY_RECEIPT_SHADOW_TEST_ROOT: stateDir,
    FACTORY_RECEIPT_SHADOW_MODE: "shadow",
    FACTORY_RECEIPT_SHADOW_AUTOMATION_ID: "7760679f-6ac8-461c-a567-43fae21c3eee",
    FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: config.activation_manifest_sha256,
    FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: config.effective_config_sha256,
    FACTORY_RECEIPT_SHADOW_CONFIG_PATH: configPath,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function verifiedExecution(stateDir: string): ShippingExecution {
  let lifecycle = createExecutionLifecycle("verified", "2026-07-26T09:00:00.000Z");
  lifecycle = transitionExecutionLifecycle(lifecycle, "implementation_complete", {
    kind: "implementation",
    reference: "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    recorded_at: "2026-07-26T09:30:00.000Z",
  }, { now: "2026-07-26T09:30:00.000Z" });
  lifecycle = transitionExecutionLifecycle(lifecycle, "verified", {
    kind: "manual-approval",
    reference: "marlandoj",
    recorded_at: firstTimestamp,
  }, { now: firstTimestamp });
  const execution: ShippingExecution = {
    ...lifecycle,
    execution_id: "exec-review",
    identifier: "ZOU-REVIEW",
    ticket_id: "ticket-review",
    branch_name: "factory/zou-review",
    repo_path: stateDir,
    base_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    started_at: "2026-07-26T09:00:00.000Z",
    completed_at: firstTimestamp,
    stage: "verified",
    status: "verified",
    pr_number: null,
    pr_url: null,
  };
  writeFileSync(join(stateDir, "exec-exec-review.json"), `${JSON.stringify(execution, null, 2)}\n`);
  return execution;
}

function clock(...timestamps: string[]): () => string {
  let index = 0;
  return () => timestamps[Math.min(index++, timestamps.length - 1)]!;
}

const mergeQueued: Shipper = async () => ({
  outcome: "merge_queued",
  pr_number: 431,
  pr_url: "https://github.com/marlandoj/zouroboros/pull/431",
});

describe("ship-ready deterministic runner", () => {
  test("change-quiz off returns before reading the diff or writing artifacts", async () => {
    const stateDir = temporaryDirectory("shipping-quiz-off-");
    const execution = verifiedExecution(stateDir);
    let diffReads = 0;
    const result = await runPrePrChangeQuiz(execution, () => {
      diffReads++;
      return "diff";
    }, {
      stateDir,
      changeQuizMode: "off",
      changeQuizEvaluationsDir: join(stateDir, "evaluations"),
    });
    expect(result).toBeNull();
    expect(diffReads).toBe(0);
    expect(existsSync(join(stateDir, "evaluations"))).toBe(false);
  });

  test("advisory change-quiz persists evidence and never blocks PR creation", async () => {
    const stateDir = temporaryDirectory("shipping-quiz-advisory-");
    const evaluationsDir = join(stateDir, "evaluations");
    const execution = verifiedExecution(stateDir);
    execution.ticket_title = "Change one file";
    execution.change_quiz_answers = {
      files_modified: ["scripts/example.ts"],
      primary_change: "Changes the example behavior.",
      scope_not_changed: "Leaves unrelated behavior unchanged.",
      side_effects: "The example caller could regress.",
      control_flags: [],
    };
    const result = await runPrePrChangeQuiz(execution, () => [
      "diff --git a/scripts/example.ts b/scripts/example.ts",
      "--- a/scripts/example.ts",
      "+++ b/scripts/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n"), {
      stateDir,
      changeQuizMode: "advisory",
      changeQuizEvaluationsDir: evaluationsDir,
      now: () => secondTimestamp,
      changeQuizGrader: async ({ questions }) => ({
        scores: Object.fromEntries(questions.map((question) => [question.id, 1])),
        model_id: "test",
        cost_usd: 0.001,
      }),
    });
    expect(result?.artifact).toMatchObject({ passed: true, blocking: false, score: 1 });
    expect(existsSync(result!.artifact_path)).toBe(true);
    expect(JSON.parse(readFileSync(join(evaluationsDir, "change-quiz-rollout.json"), "utf8"))).toMatchObject({
      advisory_started_at: secondTimestamp,
      real_samples: 1,
      eligible_for_enforcement: false,
    });
  });

  test("enforcement fails closed until the five-day advisory gate matures", async () => {
    const stateDir = temporaryDirectory("shipping-quiz-enforce-");
    const execution = verifiedExecution(stateDir);
    execution.change_quiz_answers = {
      files_modified: ["scripts/example.ts"],
      primary_change: "Changes the example behavior.",
      scope_not_changed: "Leaves unrelated behavior unchanged.",
      side_effects: "The example caller could regress.",
      control_flags: [],
    };
    await expect(runPrePrChangeQuiz(execution, () => [
      "--- a/scripts/example.ts",
      "+++ b/scripts/example.ts",
      "+export const value = 2;",
    ].join("\n"), {
      stateDir,
      changeQuizMode: "enforce",
      changeQuizEvaluationsDir: join(stateDir, "evaluations"),
      now: () => secondTimestamp,
      changeQuizGrader: async ({ questions }) => ({
        scores: Object.fromEntries(questions.map((question) => [question.id, 1])),
        model_id: "test",
        cost_usd: null,
      }),
    })).rejects.toThrow("enforcement is not mature");
  });

  test("bounds generated pull request titles to GitHub's maximum", () => {
    const title = buildPullRequestTitle({
      identifier: "ZOU-933",
      execution_id: "exec-d50452ec",
      result_summary: "x".repeat(400),
    });

    expect(Array.from(title)).toHaveLength(MAX_PULL_REQUEST_TITLE_LENGTH);
    expect(title.startsWith("ZOU-933: ")).toBe(true);
  });

  test("uses the execution id when no result summary exists", () => {
    expect(buildPullRequestTitle({
      identifier: "ZOU-REVIEW",
      execution_id: "exec-review",
      result_summary: null,
    })).toBe("ZOU-REVIEW: factory execution exec-review");
  });

  test("manual approval creates one durable, idempotent shipping request", () => {
    const stateDir = temporaryDirectory("shipping-request-");
    const execution = verifiedExecution(stateDir);
    const first = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const second = queueShippingRequest(execution, { stateDir, now: () => secondTimestamp });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "queued",
      step: "queued",
      attempt_count: 0,
      execution_id: "exec-review",
      identifier: "ZOU-REVIEW",
      source_branch: "factory/zou-review",
    });
    expect(JSON.parse(readFileSync(join(stateDir, "shipping-request-exec-review.json"), "utf8"))).toEqual(first);
  });

  test("a successful request persists its PR and is not executed twice", async () => {
    const stateDir = temporaryDirectory("shipping-success-");
    const execution = verifiedExecution(stateDir);
    queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    let calls = 0;
    const shipper: Shipper = async (...args) => {
      calls++;
      return mergeQueued(...args);
    };

    const first = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp, secondTimestamp),
      shipper,
    });
    const second = await runShippingRequest("exec-review", { stateDir, shipper });

    expect(calls).toBe(1);
    expect(first).toMatchObject({
      status: "succeeded",
      outcome: "merge_queued",
      pr_number: 431,
      attempt_count: 1,
    });
    expect(second).toEqual(first);
  });

  test("a failed request remains visible and can be explicitly requeued", async () => {
    const stateDir = temporaryDirectory("shipping-retry-");
    const execution = verifiedExecution(stateDir);
    queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });

    await expect(runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp),
      shipper: async () => {
        throw new Error("push rejected");
      },
    })).rejects.toThrow("push rejected");
    expect(loadShippingAttempt("exec-review", stateDir)).toMatchObject({
      status: "failed",
      attempt_count: 1,
      error: "push rejected",
    });

    expect(queueShippingRequest(execution, { stateDir, now: () => secondTimestamp }).status).toBe("queued");
    const recovered = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(secondTimestamp, secondTimestamp),
      shipper: mergeQueued,
    });
    expect(recovered).toMatchObject({ status: "succeeded", attempt_count: 2, error: null });
  });

  test("shadow shipping keeps retries under one operation and terminalizes only success", async () => {
    const stateDir = temporaryDirectory("shipping-shadow-retry-");
    const registryPath = join(stateDir, "shadow-registry.json");
    const dbPath = join(stateDir, "shadow.sqlite");
    writeFileSync(
      registryPath,
      readFileSync(join(import.meta.dir, "..", "config", "run-receipt-shadow-adapters.json")),
    );
    const prior = { ...process.env };
    const shadowEnv = shadowEnvironment(stateDir, dbPath, registryPath);
    Object.assign(process.env, shadowEnv);
    try {
      const execution = verifiedExecution(stateDir);
      queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
      await expect(runShippingRequest("exec-review", {
        stateDir,
        now: clock(firstTimestamp, secondTimestamp),
        shipper: async () => { throw new Error("transient push rejection"); },
      })).rejects.toThrow("transient push rejection");
      queueShippingRequest(execution, { stateDir, now: () => secondTimestamp });
      const recovered = await runShippingRequest("exec-review", {
        stateDir,
        now: clock(secondTimestamp, secondTimestamp),
        shipper: mergeQueued,
      });
      expect(recovered).toMatchObject({ status: "succeeded", attempt_count: 2 });
      const db = new Database(dbPath, { readonly: true });
      try {
        expect((db.query("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count).toBe(1);
        expect((db.query("SELECT COUNT(*) AS count FROM receipts").get() as { count: number }).count).toBe(1);
        expect((db.query("SELECT COUNT(*) AS count FROM journal_events WHERE kind = 'attempt.started'").get() as { count: number }).count).toBe(2);
        const payloads = (db.query("SELECT canonical_payload FROM journal_events").all() as Array<{ canonical_payload: string }>)
          .map((row) => row.canonical_payload).join("\n");
        expect(payloads).not.toContain("transient push rejection");
        expect(payloads).toContain("shipping_attempt_failed");
      } finally {
        db.close();
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
    }
  });

  test("shadow cohort excludes no-patch runs and retains already-merged outcomes", async () => {
    const stateDir = temporaryDirectory("shipping-shadow-cohort-");
    const registryPath = join(stateDir, "shadow-registry.json");
    const dbPath = join(stateDir, "shadow.sqlite");
    writeFileSync(registryPath, readFileSync(join(import.meta.dir, "..", "config", "run-receipt-shadow-adapters.json")));
    const prior = { ...process.env };
    const shadowEnv = shadowEnvironment(stateDir, dbPath, registryPath);
    Object.assign(process.env, shadowEnv);
    try {
      const noPatch = verifiedExecution(stateDir);
      queueShippingRequest(noPatch, { stateDir, now: () => firstTimestamp });
      await runShippingRequest("exec-review", {
        stateDir,
        now: clock(firstTimestamp, secondTimestamp),
        shipper: async () => ({ outcome: "no_patch_novel", pr_number: null, pr_url: null }),
      });
      expect(buildReceiptShadowReport(dbPath).classes.external_side_effect).toMatchObject({ operations: 0, excluded: 1 });

      const merged = { ...verifiedExecution(stateDir), execution_id: "exec-merged" };
      writeFileSync(join(stateDir, "exec-exec-merged.json"), `${JSON.stringify(merged, null, 2)}\n`);
      queueShippingRequest(merged, { stateDir, now: () => firstTimestamp });
      await runShippingRequest("exec-merged", {
        stateDir,
        now: clock(firstTimestamp, secondTimestamp),
        shipper: async () => ({ outcome: "already_merged", pr_number: 430, pr_url: "https://github.com/marlandoj/zouroboros/pull/430" }),
      });
      expect(buildReceiptShadowReport(dbPath).classes.external_side_effect).toMatchObject({ operations: 1, excluded: 1, receipts: 1 });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
    }
  });

  test("an already merged PR is a successful idempotent outcome", async () => {
    const stateDir = temporaryDirectory("shipping-merged-");
    queueShippingRequest(verifiedExecution(stateDir), { stateDir, now: () => firstTimestamp });
    const result = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp),
      shipper: async () => ({
        outcome: "already_merged",
        pr_number: 430,
        pr_url: "https://github.com/marlandoj/zouroboros/pull/430",
      }),
    });
    expect(result).toMatchObject({ status: "succeeded", outcome: "already_merged", pr_number: 430 });
  });

  test("the real shipper recognizes a merged PR and records contiguous lifecycle evidence", async () => {
    const stateDir = temporaryDirectory("shipping-real-merged-");
    const execution = verifiedExecution(stateDir);
    const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const calls: string[] = [];
    const command: CommandRunner = (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${stateDir}\n`, stderr: "" };
      if (program === "gh" && args[0] === "repo") return { status: 0, stdout: "marlandoj/zouroboros\n", stderr: "" };
      if (program === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          status: 0,
          stdout: `${JSON.stringify([{ number: 430, state: "MERGED", url: "https://github.com/marlandoj/zouroboros/pull/430", isDraft: false, headRefName: "factory/zou-review" }])}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: stateDir,
      command,
      now: () => secondTimestamp,
    });
    expect(result).toMatchObject({ outcome: "already_merged", pr_number: 430 });
    expect(calls.some((call) => call.includes("gh pr merge"))).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "exec-exec-review.json"), "utf8"))).toMatchObject({
      state: "merged",
      stage: "merged",
      status: "merged",
      pr_number: 430,
    });
  });

  test("the real shipper reuses an open PR and queues protected auto-merge", async () => {
    const stateDir = temporaryDirectory("shipping-real-open-");
    const execution = verifiedExecution(stateDir);
    const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const calls: string[] = [];
    const command: CommandRunner = (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${stateDir}\n`, stderr: "" };
      if (program === "gh" && args[0] === "repo") return { status: 0, stdout: "marlandoj/zouroboros\n", stderr: "" };
      if (program === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          status: 0,
          stdout: `${JSON.stringify([{ number: 431, state: "OPEN", url: "https://github.com/marlandoj/zouroboros/pull/431", isDraft: false, headRefName: "factory/zou-review" }])}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: stateDir,
      command,
      now: () => secondTimestamp,
    });
    expect(result).toMatchObject({ outcome: "existing_open_pr", pr_number: 431 });
    expect(calls).toContain("gh pr merge 431 --repo marlandoj/zouroboros --auto --squash");
    expect(JSON.parse(readFileSync(join(stateDir, "exec-exec-review.json"), "utf8"))).toMatchObject({
      state: "pr_ready",
      stage: "pr_ready",
      status: "pr_ready",
      pr_number: 431,
    });
  });

  test("a duplicate execution with no patch-novel commits is durably skipped", async () => {
    const stateDir = temporaryDirectory("shipping-nodiff-");
    queueShippingRequest(verifiedExecution(stateDir), { stateDir, now: () => firstTimestamp });
    const result = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp),
      shipper: async () => ({ outcome: "no_patch_novel", pr_number: null, pr_url: null }),
    });
    expect(result).toMatchObject({ status: "skipped", outcome: "no_patch_novel", error: null });
    expect((await runShippingRequest("exec-review", { stateDir, shipper: mergeQueued })).status).toBe("skipped");
  });

  test("run-ready consumes scanner output and executes each eligible request once", async () => {
    const stateDir = temporaryDirectory("shipping-scan-");
    verifiedExecution(stateDir);
    const command: CommandRunner = (program, args) => {
      expect(program).toBe("bun");
      expect(args).toContain("--min-age-minutes");
      return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          linear_ok: true,
          items: [{ execution_id: "exec-review" }],
        })}\n`,
        stderr: "",
      };
    };
    const result = await runReadyQueue({
      stateDir,
      minAgeMinutes: 0,
      command,
      now: clock(firstTimestamp, firstTimestamp, secondTimestamp),
      shipper: mergeQueued,
      codebaseIndexer: () => ({
        ok: true,
        enabled: true,
        locked: false,
        evaluated: 1,
        indexed: 0,
        skipped: 0,
        pending: 1,
        failures: [],
        results: [],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.codebase_index).toMatchObject({ ok: true, pending: 1 });
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]).toMatchObject({ status: "succeeded", outcome: "merge_queued" });
  });

  test("run-ready fails closed when the Linear join is unavailable", async () => {
    const stateDir = temporaryDirectory("shipping-linear-");
    const command: CommandRunner = () => ({
      status: 0,
      stdout: `${JSON.stringify({ ok: true, linear_ok: false, items: [] })}\n`,
      stderr: "",
    });
    await expect(runReadyQueue({ stateDir, command })).rejects.toThrow("Linear evidence");
  });

  test("run-ready surfaces Codebase MCP reconciliation failures without rewriting shipping receipts", async () => {
    const stateDir = temporaryDirectory("shipping-index-failure-");
    const command: CommandRunner = () => ({
      status: 0,
      stdout: `${JSON.stringify({ ok: true, linear_ok: true, items: [] })}\n`,
      stderr: "",
    });
    const result = await runReadyQueue({
      stateDir,
      command,
      codebaseIndexer: () => ({
        ok: false,
        enabled: true,
        locked: false,
        evaluated: 1,
        indexed: 0,
        skipped: 0,
        pending: 0,
        failures: [{
          execution_id: "exec-review",
          identifier: "ZOU-REVIEW",
          repo_path: stateDir,
          pr_number: 431,
          merge_sha: "b".repeat(40),
          status: "failed",
          graph_project: null,
          receipt_path: join(stateDir, "codebase-index-test.json"),
          error: "index failed",
        }],
        results: [],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.codebase_index.failures[0]).toMatchObject({ identifier: "ZOU-REVIEW", error: "index failed" });
  });
});

describe("auto-merge fallback", () => {
  const clean = "GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)";

  function recorder(responses: Array<{ status: number; stderr?: string }>) {
    const calls: string[][] = [];
    const command: CommandRunner = (_program, args) => {
      calls.push(args);
      const next = responses.shift() ?? { status: 0 };
      return { status: next.status, stdout: "", stderr: next.stderr ?? "" };
    };
    return { calls, command };
  }

  // The repo-level form: a repository with no branch protection rule has no
  // queue for auto-merge to join. arcade-games rejects every factory PR this
  // way, which stranded ZOU-953 after the PR was already open.
  const unprotected =
    "GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)";

  test("recognises only the nothing-to-wait-for rejections", () => {
    expect(isAutoMergeUnavailable(clean)).toBe(true);
    expect(isAutoMergeUnavailable("Pull request is not in the correct state")).toBe(true);
    expect(isAutoMergeUnavailable(unprotected)).toBe(true);
    expect(isAutoMergeUnavailable("GraphQL: Resource not accessible by integration")).toBe(false);
    expect(isAutoMergeUnavailable("merge conflict between base and head")).toBe(false);
    // Adjacent but genuinely blocking — a protection rule that exists and
    // refused the update must not be read as "no protection configured".
    expect(isAutoMergeUnavailable("Protected branch update failed")).toBe(false);
    expect(isAutoMergeUnavailable("required status check is expected")).toBe(false);
  });

  test("squashes immediately when the repo has no branch protection", () => {
    const { calls, command } = recorder([{ status: 1, stderr: unprotected }, { status: 0 }]);
    expect(queueOrMergeNow(command, "owner/repo", 10, "/repo")).toEqual({ merged: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--auto");
    expect(calls[1]).toContain("--squash");
    expect(calls[1]).not.toContain("--auto");
  });

  test("queues auto-merge and does not merge when GitHub accepts", () => {
    const { calls, command } = recorder([{ status: 0 }]);
    expect(queueOrMergeNow(command, "owner/repo", 9, "/repo")).toEqual({ merged: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--auto");
  });

  test("squashes immediately when the PR is already clean", () => {
    const { calls, command } = recorder([{ status: 1, stderr: clean }, { status: 0 }]);
    expect(queueOrMergeNow(command, "owner/repo", 9, "/repo")).toEqual({ merged: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--squash");
    expect(calls[1]).not.toContain("--auto");
  });

  test("rethrows any other auto-merge failure instead of force merging", () => {
    const { calls, command } = recorder([
      { status: 1, stderr: "GraphQL: Resource not accessible by integration" },
    ]);
    expect(() => queueOrMergeNow(command, "owner/repo", 9, "/repo")).toThrow("not accessible");
    expect(calls).toHaveLength(1);
  });

  test("surfaces a failure of the fallback squash", () => {
    const { command } = recorder([
      { status: 1, stderr: clean },
      { status: 1, stderr: "Protected branch update failed" },
    ]);
    expect(() => queueOrMergeNow(command, "owner/repo", 9, "/repo")).toThrow("Protected branch");
  });
});
