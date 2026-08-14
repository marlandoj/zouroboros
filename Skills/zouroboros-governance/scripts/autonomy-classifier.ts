import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalStringify, sha256 } from "./governance-ledger";

export type AutonomyTier = "T0" | "T1" | "T2";
export type Runtime = "claude" | "codex" | "zo-native" | "mcp" | "unknown";
export type Reversibility = "reversible" | "hard-to-reverse" | "irreversible" | "unknown";
export type ThirdPartyImpact = "none" | "read" | "write" | "unknown";
export type BlastRadius = "local" | "shared" | "high" | "unknown";

export interface ClassificationInput {
  schema_version: 1;
  action: string;
  environment: string;
  resource: string;
  caller: string;
  runtime: Runtime;
  reversibility: Reversibility;
  third_party_impact: ThirdPartyImpact;
  blast_radius: BlastRadius;
}

export interface AutonomyPolicy {
  schema_version: 1;
  policy_version: string;
  mode: "shadow";
  supported_runtimes: Runtime[];
  t0_actions: string[];
  t1_actions: string[];
  deny_unknown: true;
  enforcement_enabled: false;
}

export interface ClassificationResult {
  schema_version: 1;
  policy_version: string;
  tier: AutonomyTier;
  supported_runtime: boolean;
  unknown_or_incomplete: boolean;
  reasons: string[];
  request_fingerprint: string;
}

const RUNTIMES = new Set<Runtime>(["claude", "codex", "zo-native", "mcp", "unknown"]);
const REVERSIBILITY = new Set<Reversibility>(["reversible", "hard-to-reverse", "irreversible", "unknown"]);
const THIRD_PARTY_IMPACT = new Set<ThirdPartyImpact>(["none", "read", "write", "unknown"]);
const BLAST_RADIUS = new Set<BlastRadius>(["local", "shared", "high", "unknown"]);

export function defaultPolicyPath(): string {
  return process.env.ZOUROBOROS_AUTONOMY_POLICY_PATH
    || path.resolve(import.meta.dir, "../config/autonomy-policy.json");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

export function parsePolicy(value: unknown): AutonomyPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Partial<AutonomyPolicy>;
  if (
    policy.schema_version !== 1
    || typeof policy.policy_version !== "string"
    || policy.mode !== "shadow"
    || !stringArray(policy.supported_runtimes)
    || !stringArray(policy.t0_actions)
    || !stringArray(policy.t1_actions)
    || policy.deny_unknown !== true
    || policy.enforcement_enabled !== false
  ) return null;
  return policy as AutonomyPolicy;
}

export function loadPolicy(policyPath = defaultPolicyPath()): AutonomyPolicy {
  if (!fs.existsSync(policyPath)) throw new Error(`autonomy policy missing: ${policyPath}`);
  const policy = parsePolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")) as unknown);
  if (!policy) throw new Error(`autonomy policy malformed: ${policyPath}`);
  return policy;
}

export function requestFingerprint(input: unknown): string {
  return sha256(canonicalStringify(input));
}

function normalizeInput(value: unknown): { input: ClassificationInput | null; reasons: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { input: null, reasons: ["classification input must be an object"] };
  }
  const input = value as Partial<ClassificationInput>;
  const reasons: string[] = [];
  if (input.schema_version !== 1) reasons.push("schema_version must be 1");
  for (const field of ["action", "environment", "resource", "caller"] as const) {
    if (typeof input[field] !== "string" || input[field]!.trim().length === 0) reasons.push(`${field} is missing`);
  }
  if (!RUNTIMES.has(input.runtime as Runtime)) reasons.push("runtime is unknown");
  if (!REVERSIBILITY.has(input.reversibility as Reversibility)) reasons.push("reversibility is unknown");
  if (!THIRD_PARTY_IMPACT.has(input.third_party_impact as ThirdPartyImpact)) reasons.push("third_party_impact is unknown");
  if (!BLAST_RADIUS.has(input.blast_radius as BlastRadius)) reasons.push("blast_radius is unknown");
  return reasons.length > 0
    ? { input: null, reasons }
    : { input: input as ClassificationInput, reasons: [] };
}

export function classifyAutonomy(value: unknown, policy: AutonomyPolicy): ClassificationResult {
  const fingerprint = requestFingerprint(value);
  const normalized = normalizeInput(value);
  if (!normalized.input) {
    return {
      schema_version: 1,
      policy_version: policy.policy_version,
      tier: "T2",
      supported_runtime: false,
      unknown_or_incomplete: true,
      reasons: normalized.reasons,
      request_fingerprint: fingerprint,
    };
  }

  const input = normalized.input;
  const supportedRuntime = policy.supported_runtimes.includes(input.runtime);
  const unknownDimensions = [
    input.runtime,
    input.reversibility,
    input.third_party_impact,
    input.blast_radius,
  ].includes("unknown");
  if (!supportedRuntime || unknownDimensions) {
    return {
      schema_version: 1,
      policy_version: policy.policy_version,
      tier: "T2",
      supported_runtime: supportedRuntime,
      unknown_or_incomplete: unknownDimensions,
      reasons: [!supportedRuntime ? `unsupported runtime: ${input.runtime}` : "one or more risk dimensions are unknown"],
      request_fingerprint: fingerprint,
    };
  }

  if (
    input.blast_radius === "high"
    || input.reversibility === "hard-to-reverse"
    || input.reversibility === "irreversible"
  ) {
    return {
      schema_version: 1,
      policy_version: policy.policy_version,
      tier: "T2",
      supported_runtime: true,
      unknown_or_incomplete: false,
      reasons: ["high-blast-radius or hard-to-reverse action requires per-action authorization"],
      request_fingerprint: fingerprint,
    };
  }

  if (policy.t1_actions.includes(input.action)) {
    return {
      schema_version: 1,
      policy_version: policy.policy_version,
      tier: "T1",
      supported_runtime: true,
      unknown_or_incomplete: false,
      reasons: ["action is the ratified T1 draft-PR candidate"],
      request_fingerprint: fingerprint,
    };
  }

  if (
    policy.t0_actions.includes(input.action)
    && input.environment === "workspace"
    && input.reversibility === "reversible"
    && input.third_party_impact === "none"
    && input.blast_radius === "local"
  ) {
    return {
      schema_version: 1,
      policy_version: policy.policy_version,
      tier: "T0",
      supported_runtime: true,
      unknown_or_incomplete: false,
      reasons: ["action is allowlisted and all risk dimensions are local and reversible"],
      request_fingerprint: fingerprint,
    };
  }

  return {
    schema_version: 1,
    policy_version: policy.policy_version,
    tier: "T2",
    supported_runtime: true,
    unknown_or_incomplete: !policy.t0_actions.includes(input.action) && !policy.t1_actions.includes(input.action),
    reasons: [
      !policy.t0_actions.includes(input.action) && !policy.t1_actions.includes(input.action)
        ? `unknown action: ${input.action}`
        : "action context is outside the T0 boundary",
    ],
    request_fingerprint: fingerprint,
  };
}

export function classifyWithPolicy(value: unknown, policyPath?: string): ClassificationResult {
  try {
    return classifyAutonomy(value, loadPolicy(policyPath));
  } catch (error) {
    return {
      schema_version: 1,
      policy_version: "unavailable",
      tier: "T2",
      supported_runtime: false,
      unknown_or_incomplete: true,
      reasons: [error instanceof Error ? error.message : String(error)],
      request_fingerprint: requestFingerprint(value),
    };
  }
}
