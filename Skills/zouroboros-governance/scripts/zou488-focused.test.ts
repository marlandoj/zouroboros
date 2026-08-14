import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  authorizationMaterial,
  verifyAuthorization,
  type AuthorizationEvidence,
} from "./autonomy-authorization";
import {
  classificationInputFromHook,
  evaluatePreToolUse,
  preActionRequestFingerprint,
  resolveWorkspaceTarget,
  runHermeticPreActionCanary,
  type PreToolUseInput,
} from "./autonomy-pretool-adapter";
import { classifyWithPolicy } from "./autonomy-classifier";
import { appendAuditRecord, verifyLedger } from "./governance-ledger";
import {
  bypassRequestFingerprint,
  guardToolCall,
  recordAuthorizedBypass,
} from "./governance";

const ENV_KEYS = [
  "ZOUROBOROS_GOVERNANCE_LOG_PATH",
  "ZOUROBOROS_GOVERNANCE_ANCHOR_PATH",
  "ZOUROBOROS_GOVERNANCE_ANCHOR_KEY_PATH",
  "ZOUROBOROS_APPROVAL_KEYS_PATH",
] as const;

let testDir = "";
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function evidenceFor(
  values: Omit<AuthorizationEvidence, "schema_version" | "signature">,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): AuthorizationEvidence {
  const evidence: AuthorizationEvidence = { schema_version: 1, ...values, signature: "" };
  evidence.signature = sign(null, Buffer.from(authorizationMaterial(evidence)), privateKey).toString("base64");
  return evidence;
}

function dangerousHook(overrides: Partial<PreToolUseInput> = {}): PreToolUseInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "tool-use-1",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/never-run" },
    cwd: "/home/workspace",
    ...overrides,
  };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zou488-focused-"));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
  }
  process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH = path.join(testDir, "audit.log");
  process.env.ZOUROBOROS_GOVERNANCE_ANCHOR_PATH = path.join(testDir, "anchor.log");
  process.env.ZOUROBOROS_GOVERNANCE_ANCHOR_KEY_PATH = path.join(testDir, "anchor.key");
  process.env.ZOUROBOROS_APPROVAL_KEYS_PATH = path.join(testDir, "authorities.json");
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("canonical governance ledger", () => {
  test("deduplicates retried blocked attempts by request fingerprint", () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => guardToolCall("send_email_to_user", "focused-test", "logical-request-1")).toThrow();
    }
    const report = verifyLedger();
    expect(report.ok).toBe(true);
    expect(report.blocked_attempts).toBe(1);
  });

  test("accepts a bound signature once and rejects replay", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(process.env.ZOUROBOROS_APPROVAL_KEYS_PATH!, JSON.stringify({
      operator: {
        algorithm: "ed25519",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      },
    }));
    appendAuditRecord("verdict", { fixture: true }, { idempotencyKey: "fixture-verdict" });

    const target = "gov-test-verdict";
    const reason = "bounded test bypass";
    const requestFingerprint = bypassRequestFingerprint(target, reason);
    const now = new Date();
    const evidence = evidenceFor({
      actor: "operator-session",
      action: "governance.bypass",
      resource: target,
      request_fingerprint: requestFingerprint,
      scope: "governance.bypass",
      issued_at: new Date(now.getTime() - 1_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      revoked: false,
      approving_authority: "operator",
      nonce: "nonce-1",
    }, privateKey);

    recordAuthorizedBypass({
      target_verdict_id: target,
      reason,
      actor: "operator-session",
      authorization: evidence,
    });
    expect(verifyLedger().bypass_count).toBe(1);
    expect(verifyLedger().authorization_consumptions).toBe(1);
    expect(() => recordAuthorizedBypass({
      target_verdict_id: target,
      reason,
      actor: "operator-session",
      authorization: evidence,
    })).toThrow(/already consumed/);
  });
});

describe("signed authorization bindings", () => {
  test("rejects actor, action, resource, fingerprint, scope, expiry, revocation, and signature drift", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(process.env.ZOUROBOROS_APPROVAL_KEYS_PATH!, JSON.stringify({
      operator: {
        algorithm: "ed25519",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      },
    }));
    appendAuditRecord("verdict", { fixture: true }, { idempotencyKey: "authorization-fixture" });
    const now = new Date();
    const evidence = evidenceFor({
      actor: "actor-1",
      action: "github.create_draft_pull_request",
      resource: "marlandoj/zouroboros",
      request_fingerprint: "fingerprint-1",
      scope: "pre-action",
      issued_at: new Date(now.getTime() - 1_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      revoked: false,
      approving_authority: "operator",
      nonce: "nonce-2",
    }, privateKey);
    const expected = {
      actor: evidence.actor,
      action: evidence.action,
      resource: evidence.resource,
      requestFingerprint: evidence.request_fingerprint,
      scope: evidence.scope,
    };

    expect(verifyAuthorization(evidence, expected, { now }).valid).toBe(true);
    expect(verifyAuthorization(evidence, { ...expected, actor: "other" }, { now }).valid).toBe(false);
    expect(verifyAuthorization(evidence, { ...expected, action: "other" }, { now }).valid).toBe(false);
    expect(verifyAuthorization(evidence, { ...expected, resource: "other" }, { now }).valid).toBe(false);
    expect(verifyAuthorization(evidence, { ...expected, requestFingerprint: "other" }, { now }).valid).toBe(false);
    expect(verifyAuthorization(evidence, { ...expected, scope: "other" }, { now }).valid).toBe(false);
    expect(verifyAuthorization({ ...evidence, revoked: true }, expected, { now }).valid).toBe(false);
    expect(verifyAuthorization({ ...evidence, expires_at: now.toISOString() }, expected, { now }).valid).toBe(false);
    expect(verifyAuthorization({ ...evidence, signature: Buffer.alloc(64).toString("base64") }, expected, { now }).valid).toBe(false);
  });

  test("binds complete canonical tool payload, actor, runtime, and context", () => {
    const hook = dangerousHook({
      tool_name: "mcp__github__create_pull_request",
      tool_input: {
        repository: "marlandoj/zouroboros",
        draft: true,
        title: "Bound title",
        body: { summary: "one", checks: ["test", "tsc"] },
      },
      runtime: "claude",
      permission_mode: "default",
    });
    const baseline = preActionRequestFingerprint(hook);
    expect(preActionRequestFingerprint({
      ...hook,
      tool_input: {
        body: { checks: ["test", "tsc"], summary: "one" },
        title: "Bound title",
        draft: true,
        repository: "marlandoj/zouroboros",
      },
    })).toBe(baseline);

    const mutations: PreToolUseInput[] = [
      { ...hook, session_id: "session-2" },
      { ...hook, tool_use_id: "tool-use-2" },
      { ...hook, tool_name: "mcp__github__update_pull_request" },
      { ...hook, runtime: "codex" },
      { ...hook, cwd: "/home/workspace/Projects" },
      { ...hook, permission_mode: "plan" },
      { ...hook, tool_input: { ...hook.tool_input, title: "Mutated title" } },
      { ...hook, tool_input: { ...hook.tool_input, body: { summary: "two", checks: ["test", "tsc"] } } },
      { ...hook, tool_input: { ...hook.tool_input, body: { summary: "one", checks: ["test"] } } },
    ];
    for (const mutation of mutations) {
      expect(preActionRequestFingerprint(mutation)).not.toBe(baseline);
    }
  });

  test("atomically reserves one authorization across competing processes", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(process.env.ZOUROBOROS_APPROVAL_KEYS_PATH!, JSON.stringify({
      operator: {
        algorithm: "ed25519",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      },
    }));
    appendAuditRecord("verdict", { fixture: true }, { idempotencyKey: "multiprocess-fixture" });
    const now = new Date();
    const evidence = evidenceFor({
      actor: "concurrent-actor",
      action: "github.create_draft_pull_request",
      resource: "marlandoj/zouroboros",
      request_fingerprint: "concurrent-fingerprint",
      scope: "pre-action",
      issued_at: new Date(now.getTime() - 1_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      revoked: false,
      approving_authority: "operator",
      nonce: "concurrent-nonce",
    }, privateKey);
    const fixturePath = path.join(testDir, "reservation-fixture.json");
    fs.writeFileSync(fixturePath, JSON.stringify({
      evidence,
      expected: {
        actor: evidence.actor,
        action: evidence.action,
        resource: evidence.resource,
        requestFingerprint: evidence.request_fingerprint,
        scope: evidence.scope,
      },
    }));
    const worker = path.join(import.meta.dir, "zou488-reservation-worker.ts");
    const processes = Array.from({ length: 12 }, () => Bun.spawn(
      [process.execPath, worker, fixturePath],
      { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    ));
    const exitCodes = await Promise.all(processes.map((process) => process.exited));
    expect(exitCodes.filter((code) => code === 0)).toHaveLength(1);
    expect(exitCodes.filter((code) => code !== 0)).toHaveLength(11);
    const report = verifyLedger();
    expect(report.ok).toBe(true);
    expect(report.authorization_consumptions).toBe(1);
  });
});

describe("workspace containment", () => {
  test("rejects lexical and symlink escapes for every filesystem tool family", () => {
    const root = path.join(testDir, "workspace");
    const inside = path.join(root, "inside");
    fs.mkdirSync(inside, { recursive: true });
    fs.symlinkSync("/tmp", path.join(inside, "escape"));
    expect(resolveWorkspaceTarget("file.md", inside, root)).toBe(path.join(inside, "file.md"));
    expect(resolveWorkspaceTarget("../../outside", inside, root)).toBeNull();
    expect(resolveWorkspaceTarget("escape/outside", inside, root)).toBeNull();

    for (const [tool_name, tool_input] of [
      ["Read", { file_path: "/etc/passwd" }],
      ["Write", { file_path: "../../etc/passwd", content: "x" }],
      ["Edit", { file_path: "/tmp/outside", old_string: "a", new_string: "b" }],
      ["NotebookEdit", { notebook_path: "/tmp/outside.ipynb" }],
      ["Glob", { path: "/tmp", pattern: "**/*" }],
      ["Grep", { path: "/tmp", pattern: "secret" }],
    ] as const) {
      const classification = classifyWithPolicy(classificationInputFromHook(dangerousHook({
        tool_use_id: `escape-${tool_name}`,
        tool_name,
        tool_input,
      })));
      expect(classification.tier).toBe("T2");
    }

    const mixedTargets = classifyWithPolicy(classificationInputFromHook(dangerousHook({
      tool_use_id: "mixed-targets",
      tool_name: "Read",
      tool_input: { file_path: "/home/workspace/README.md", path: "/etc/passwd" },
    })));
    expect(mixedTargets.tier).toBe("T2");
  });

  test("does not classify Bash or Git output flags as T0", () => {
    for (const command of ["git status", "git status --output=/tmp/exfiltrated", "git diff --output=/tmp/exfiltrated"]) {
      const classification = classifyWithPolicy(classificationInputFromHook(dangerousHook({
        tool_use_id: command,
        tool_input: { command },
      })));
      expect(classification.tier).toBe("T2");
    }
  });
});

describe("shadow pre-action adapter", () => {
  test("observes a T2 action without executing or enforcing it", () => {
    const result = evaluatePreToolUse(dangerousHook());
    expect(result.classification.tier).toBe("T2");
    expect(result.would_deny).toBe(true);
    expect(result.output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(result.logged).toBe(true);
    evaluatePreToolUse(dangerousHook());
    expect(verifyLedger().autonomy_decisions).toBe(1);
  });

  test("never emits a permission decision for malformed input, missing policy, or audit failure", () => {
    const malformed = evaluatePreToolUse({ hook_event_name: "PreToolUse" });
    expect(malformed.output.hookSpecificOutput.permissionDecision).toBeUndefined();
    const missingPolicy = evaluatePreToolUse(dangerousHook({ tool_use_id: "missing-policy" }), {
      policyPath: path.join(testDir, "missing-policy.json"),
    });
    expect(missingPolicy.output.hookSpecificOutput.permissionDecision).toBeUndefined();

    const validAuditPath = process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH!;
    process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH = testDir;
    const auditFailure = evaluatePreToolUse(dangerousHook({ tool_use_id: "audit-failure" }));
    process.env.ZOUROBOROS_GOVERNANCE_LOG_PATH = validAuditPath;
    expect(auditFailure.output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(auditFailure.logged).toBe(false);
  });

  test("hermetic canary denies before a T2 side effect and allows T0", () => {
    let dangerousSideEffect = false;
    const denied = runHermeticPreActionCanary(dangerousHook(), () => {
      dangerousSideEffect = true;
    });
    expect(denied.output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(dangerousSideEffect).toBe(false);

    let readSideEffect = false;
    const allowed = runHermeticPreActionCanary(dangerousHook({
      tool_use_id: "tool-use-read",
      tool_name: "Read",
      tool_input: { file_path: "/home/workspace/README.md" },
    }), () => {
      readSideEffect = true;
    });
    expect(allowed.output.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(readSideEffect).toBe(true);
  });

  test("hermetic canary accepts valid signed T1 evidence", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(process.env.ZOUROBOROS_APPROVAL_KEYS_PATH!, JSON.stringify({
      operator: {
        algorithm: "ed25519",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      },
    }));
    appendAuditRecord("verdict", { fixture: true }, { idempotencyKey: "adapter-auth-fixture" });
    const hook = dangerousHook({
      tool_use_id: "draft-pr",
      tool_name: "mcp__github__create_pull_request",
      tool_input: { repository: "marlandoj/zouroboros", draft: true },
    });
    const classificationInput = classificationInputFromHook(hook);
    const requestFingerprint = preActionRequestFingerprint(hook);
    const now = new Date();
    const evidence = evidenceFor({
      actor: hook.session_id,
      action: classificationInput.action,
      resource: classificationInput.resource,
      request_fingerprint: requestFingerprint,
      scope: "pre-action",
      issued_at: new Date(now.getTime() - 1_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      revoked: false,
      approving_authority: "operator",
      nonce: "nonce-adapter",
    }, privateKey);
    let called = false;
    const result = runHermeticPreActionCanary(hook, () => {
      called = true;
    }, { authorizationEvidence: evidence });
    expect(result.classification.tier).toBe("T1");
    expect(result.authorization?.valid).toBe(true);
    expect(result.output.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(called).toBe(true);
    expect(verifyLedger().authorization_consumptions).toBe(1);

    let replayCalled = false;
    const replay = runHermeticPreActionCanary(hook, () => {
      replayCalled = true;
    }, { authorizationEvidence: evidence });
    expect(replay.output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(replay.authorization?.valid).toBe(false);
    expect(replay.authorization?.reason).toMatch(/already consumed/);
    expect(replayCalled).toBe(false);
    expect(verifyLedger().authorization_consumptions).toBe(1);
  });
});
