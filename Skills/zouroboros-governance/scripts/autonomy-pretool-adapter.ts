#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyWithPolicy,
  type ClassificationInput,
  type ClassificationResult,
  type Runtime,
} from "./autonomy-classifier";
import {
  consumeAuthorization,
  verifyAuthorization,
  type AuthorizationEvidence,
  type AuthorizationResult,
} from "./autonomy-authorization";
import { appendAuditRecord, canonicalStringify, sha256 } from "./governance-ledger";

export type AdapterMode = "shadow" | "hermetic-canary";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface PreToolUseInput {
  hook_event_name: "PreToolUse";
  session_id: string;
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
  runtime?: Runtime;
  permission_mode?: string;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision?: PermissionDecision;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

export interface AdapterResult {
  mode: AdapterMode;
  output: HookOutput;
  classification: ClassificationResult;
  classification_input: ClassificationInput | null;
  authorization: AuthorizationResult | null;
  would_deny: boolean;
  logged: boolean;
}

export interface AdapterOptions {
  mode?: AdapterMode;
  policyPath?: string;
  authorizationEvidence?: AuthorizationEvidence;
}

const RUNTIMES = new Set<Runtime>(["claude", "codex", "zo-native", "mcp", "unknown"]);
const READ_TOOLS = new Map([
  ["Read", "workspace.read"],
  ["Glob", "workspace.search"],
  ["Grep", "workspace.search"],
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const WORKSPACE_ROOT = "/home/workspace";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseHookInput(value: unknown): PreToolUseInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<PreToolUseInput>;
  if (
    input.hook_event_name !== "PreToolUse"
    || !nonEmpty(input.session_id)
    || !nonEmpty(input.tool_use_id)
    || !nonEmpty(input.tool_name)
    || !input.tool_input
    || typeof input.tool_input !== "object"
    || Array.isArray(input.tool_input)
  ) return null;
  if (input.runtime !== undefined && !RUNTIMES.has(input.runtime)) return null;
  return input as PreToolUseInput;
}

function inputString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (nonEmpty(input[key])) return input[key].trim();
  }
  return undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestor(candidate: string): string | null {
  const suffix: string[] = [];
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.resolve(fs.realpathSync(current), ...suffix);
  } catch {
    return null;
  }
}

export function resolveWorkspaceTarget(
  rawTarget: string | undefined,
  cwd: string | undefined,
  workspaceRoot = WORKSPACE_ROOT,
): string | null {
  try {
    const realRoot = fs.realpathSync(workspaceRoot);
    const rawCwd = nonEmpty(cwd) ? path.resolve(cwd) : realRoot;
    const resolvedCwd = resolveThroughExistingAncestor(rawCwd);
    if (!resolvedCwd || !isWithin(realRoot, resolvedCwd)) return null;
    if (!nonEmpty(rawTarget)) return resolvedCwd;
    const lexicalTarget = path.resolve(rawCwd, rawTarget);
    if (!isWithin(path.resolve(workspaceRoot), lexicalTarget)) return null;
    const resolvedTarget = resolveThroughExistingAncestor(lexicalTarget);
    return resolvedTarget && isWithin(realRoot, resolvedTarget) ? resolvedTarget : null;
  } catch {
    return null;
  }
}

function resolveAllWorkspaceTargets(
  input: Record<string, unknown>,
  keys: string[],
  cwd: string | undefined,
  fallbackToCwd: boolean,
): string | null {
  const targets = keys.flatMap((key) => nonEmpty(input[key]) ? [input[key].trim()] : []);
  if (targets.length === 0) return fallbackToCwd ? resolveWorkspaceTarget(undefined, cwd) : null;
  const resolved = targets.map((target) => resolveWorkspaceTarget(target, cwd));
  return resolved.every((target): target is string => target !== null) ? resolved[0] : null;
}

function normalizedCwd(cwd: string | undefined): string {
  return nonEmpty(cwd) ? path.resolve(cwd) : WORKSPACE_ROOT;
}

export function preActionRequestFingerprint(input: PreToolUseInput): string {
  return sha256(canonicalStringify({
    schema_version: 1,
    actor: { session_id: input.session_id },
    runtime: input.runtime || "claude",
    context: {
      hook_event_name: input.hook_event_name,
      tool_use_id: input.tool_use_id,
      cwd: normalizedCwd(input.cwd),
      permission_mode: input.permission_mode,
    },
    tool: {
      name: input.tool_name.trim(),
      input: input.tool_input,
    },
  }));
}

export function classificationInputFromHook(input: PreToolUseInput): ClassificationInput {
  const caller = `claude-pretooluse:${input.session_id}:${input.tool_use_id}`;
  const runtime = input.runtime || "claude";
  const readAction = READ_TOOLS.get(input.tool_name);
  if (readAction) {
    const resource = resolveAllWorkspaceTargets(
      input.tool_input,
      input.tool_name === "Read" ? ["file_path", "path"] : ["path"],
      input.cwd,
      input.tool_name !== "Read",
    );
    return {
      schema_version: 1,
      action: readAction,
      environment: resource ? "workspace" : "unknown",
      resource: resource || "outside-workspace",
      caller,
      runtime,
      reversibility: "reversible",
      third_party_impact: "none",
      blast_radius: resource ? "local" : "unknown",
    };
  }

  if (EDIT_TOOLS.has(input.tool_name)) {
    const resource = resolveAllWorkspaceTargets(
      input.tool_input,
      input.tool_name === "NotebookEdit" ? ["notebook_path", "file_path"] : ["file_path"],
      input.cwd,
      false,
    );
    return {
      schema_version: 1,
      action: "workspace.edit",
      environment: resource ? "workspace" : "unknown",
      resource: resource || "outside-workspace",
      caller,
      runtime,
      reversibility: "reversible",
      third_party_impact: "none",
      blast_radius: resource ? "local" : "unknown",
    };
  }

  if (/create[_-]?pull[_-]?request/i.test(input.tool_name) && input.tool_input.draft === true) {
    return {
      schema_version: 1,
      action: "github.create_draft_pull_request",
      environment: "third-party",
      resource: inputString(input.tool_input, ["repository", "repo", "head"]) || "unknown",
      caller,
      runtime,
      reversibility: "reversible",
      third_party_impact: "write",
      blast_radius: "shared",
    };
  }

  return {
    schema_version: 1,
    action: `claude.tool.${input.tool_name}`,
    environment: "unknown",
    resource: inputString(input.tool_input, ["file_path", "path"]) || input.cwd || "unknown",
    caller,
    runtime,
    reversibility: "unknown",
    third_party_impact: "unknown",
    blast_radius: "unknown",
  };
}

function hookOutput(decision: PermissionDecision | undefined, reason: string): HookOutput {
  if (decision === undefined) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: reason,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

export function evaluatePreToolUse(value: unknown, options: AdapterOptions = {}): AdapterResult {
  const mode = options.mode || "shadow";
  const hookInput = parseHookInput(value);
  const classificationInput = hookInput ? classificationInputFromHook(hookInput) : null;
  const baseClassification = classifyWithPolicy(classificationInput || value, options.policyPath);
  const classification = hookInput
    ? { ...baseClassification, request_fingerprint: preActionRequestFingerprint(hookInput) }
    : baseClassification;
  const classifierUnavailable = classification.policy_version === "unavailable";
  const malformed = hookInput === null;
  let authorization: AuthorizationResult | null = null;

  if (options.authorizationEvidence && classificationInput && classification.tier !== "T0") {
    authorization = verifyAuthorization(options.authorizationEvidence, {
      actor: hookInput!.session_id,
      action: classificationInput.action,
      resource: classificationInput.resource,
      requestFingerprint: classification.request_fingerprint,
      scope: "pre-action",
    }, { requireUnused: mode === "shadow" });
    if (mode === "hermetic-canary" && authorization.valid) {
      try {
        consumeAuthorization(options.authorizationEvidence);
      } catch (error) {
        authorization = {
          valid: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const authorized = authorization?.valid === true;
  const wouldDeny = classification.tier !== "T0" && !authorized;
  let decision: PermissionDecision | undefined;
  let reason: string;
  if (mode === "shadow") {
    decision = undefined;
    reason = classifierUnavailable || malformed
      ? `shadow observation only; runtime permissions unchanged; fail-closed intent recorded: ${classification.reasons.join("; ")}`
      : `shadow observation only; runtime permissions unchanged: classified ${classification.tier}${wouldDeny ? "; would deny without valid authorization" : ""}`;
  } else if (classifierUnavailable || malformed) {
    decision = "ask";
    reason = `fail-closed adapter input: ${classification.reasons.join("; ")}`;
  } else if (wouldDeny) {
    decision = "deny";
    reason = `hermetic canary denied ${classification.tier}: ${classification.reasons.join("; ")}`;
  } else {
    decision = "allow";
    reason = authorized ? "hermetic canary accepted valid scoped authorization" : "hermetic canary allowed T0 action";
  }

  let logged = false;
  try {
    appendAuditRecord("autonomy-decision", {
      adapter: "claude-pretooluse",
      mode,
      permission_decision: decision || "unchanged",
      would_deny: wouldDeny,
      classification_input: classificationInput,
      classification,
      authorization: authorization
        ? { valid: authorization.valid, reason: authorization.reason, authority: authorization.authority }
        : null,
    }, { idempotencyKey: `autonomy-decision:${mode}:${classification.request_fingerprint}` });
    logged = true;
  } catch (error) {
    decision = mode === "shadow" ? undefined : "ask";
    reason = `fail-closed audit failure: ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    mode,
    output: hookOutput(decision, reason),
    classification,
    classification_input: classificationInput,
    authorization,
    would_deny: wouldDeny,
    logged,
  };
}

export function runHermeticPreActionCanary(
  value: unknown,
  sideEffect: () => void,
  options: Omit<AdapterOptions, "mode"> = {},
): AdapterResult {
  const result = evaluatePreToolUse(value, { ...options, mode: "hermetic-canary" });
  if (result.output.hookSpecificOutput.permissionDecision === "allow") sideEffect();
  return result;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  try {
    const raw = JSON.parse(await readStdin()) as unknown;
    const result = evaluatePreToolUse(raw, { mode: "shadow" });
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(hookOutput(
      undefined,
      `shadow observation only; runtime permissions unchanged; fail-closed hook intent: ${error instanceof Error ? error.message : String(error)}`,
    ))}\n`);
  }
}
