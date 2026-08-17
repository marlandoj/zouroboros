import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createZoMcpListPersonasCaller,
  resolvePersonas,
  type PersonaResolutionResult,
  type ResolvedPersona,
} from "./persona-directory";
import {
  selectIndependentReviewerModel,
  resolveModelVendor,
  type SpecialistReviewerPolicy,
  type SpecialistReviewerSelection,
} from "./specialist-reviewer";
import type {
  Campaign,
  PersonaPhase,
  SeedPersonaAssociation,
  SeedPersonaFleetRole,
  TaskPersonaAssignment,
  WorkItem,
} from "./pool-queue";

export type PersonaOrchestrationMode = "off" | "shadow" | "enforce";
export type PersonaInvocationStatus = "invoked" | "would_invoke" | "omitted" | "blocked" | "not_invoked";

export interface PersonaCallRequest {
  input: string;
  model_name: string;
  persona_id: string;
  timeout_ms: number;
}

export interface PersonaCallResult {
  output: string;
  model_name: string;
  cost_usd: number | null;
}

export interface PersonaInvocationEvidence {
  role_id: string;
  phase: PersonaPhase;
  required: boolean;
  status: PersonaInvocationStatus;
  selector: string;
  persona_id: string | null;
  persona_name: string | null;
  scopes: string[];
  owned_paths: string[];
  association_version: string;
  association_sha256: string;
  directory_snapshot_hash: string | null;
  model_name: string;
  resolved_model_name: string | null;
  harness: "zo-ask";
  invocation_key: string | null;
  requested_at: string | null;
  completed_at: string | null;
  prompt_sha256: string | null;
  result_sha256: string | null;
  artifact_ref: string | null;
  artifact_sha256: string | null;
  result_ref: string | null;
  cost_usd: number | null;
  reused: boolean;
  verdict: "pass" | "fail" | null;
  model_vendor?: string | null;
  implementer_model_name?: string | null;
  implementer_vendor?: string | null;
  distinct_model?: boolean | null;
  vendor_diverse?: boolean | null;
  reason: string | null;
}

export interface PersonaOrchestrationRecord {
  version: 1;
  campaign_id: string;
  task_id: string;
  mode: PersonaOrchestrationMode;
  association: {
    template_reference: string;
    version: string;
    sha256: string;
    content_fingerprint: string;
  };
  directory: {
    snapshot_hash: string | null;
    captured_at: string | null;
  };
  invocations: PersonaInvocationEvidence[];
  omitted_roles: Array<{ role_id: string; reason: string }>;
  blocked_reason: string | null;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface PersonaAdviceInput {
  role_id: string;
  persona_name: string;
  artifact_ref: string;
  content: string;
}

export interface PersonaPreparation {
  record: PersonaOrchestrationRecord | null;
  advice: PersonaAdviceInput[];
  main_persona_id: string | null;
  main_owned_paths: string[];
  new_cost_usd: number;
  blocked_reason: string | null;
}

export interface PersonaReviewGateResult {
  mode: PersonaOrchestrationMode;
  pass: boolean;
  required_count: number;
  invoked_count: number;
  reviews: PersonaInvocationEvidence[];
  summary: string;
  new_cost_usd: number;
}

export interface PersonaOrchestratorDeps {
  mode?: PersonaOrchestrationMode;
  list_personas?: () => Promise<unknown>;
  invoke_persona?: (request: PersonaCallRequest) => Promise<PersonaCallResult>;
  registered_persona_names?: string[];
  swarm_persona_registry_path?: string;
  artifact_dir?: string;
  timeout_ms?: number;
  now?: () => string;
  reviewer_policy?: SpecialistReviewerPolicy;
}

interface InvocationArtifact {
  version: 1;
  invocation_key: string;
  role_id: string;
  phase: PersonaPhase;
  persona_id: string;
  persona_name: string;
  model_name: string;
  prompt_sha256: string;
  status: "success" | "failure";
  requested_at: string;
  completed_at: string;
  output: string | null;
  result_sha256: string | null;
  cost_usd: number | null;
  verdict: "pass" | "fail" | null;
  error: string | null;
}

const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TASK_CALLS = 8;
const REGISTERED_PERSONA_PREFIXES = ["GameDev · "];

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function finiteCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function responseOutput(payload: Record<string, unknown>): string {
  const output = payload.output ?? payload.result ?? payload.message;
  if (typeof output === "string" && output.trim()) return output.trim();
  if (output && typeof output === "object") return JSON.stringify(output);
  throw new Error("persona /zo/ask response has no non-empty output");
}

export function resolvePersonaOrchestrationMode(
  env: Record<string, string | undefined> = process.env,
): PersonaOrchestrationMode {
  const mode = env.FACTORY_PERSONA_ROUTING_MODE ?? "off";
  if (mode !== "off" && mode !== "shadow" && mode !== "enforce") {
    throw new Error(`FACTORY_PERSONA_ROUTING_MODE must be off|shadow|enforce, got ${mode}`);
  }
  return mode;
}

export function personaTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FACTORY_PERSONA_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 15 * 60_000) {
    throw new Error(`FACTORY_PERSONA_TIMEOUT_MS must be an integer from 1000 to 900000, got ${raw}`);
  }
  return value;
}

export function buildPersonaZoAskBody(
  input: string,
  model_name: string,
  persona_id: string,
): { input: string; model_name: string; persona_id: string } {
  return { input, model_name, persona_id };
}

export function resolvePersonaZoAskAuthorization(
  env: Record<string, string | undefined> = process.env,
): string {
  const identityToken = env.ZO_CLIENT_IDENTITY_TOKEN?.trim();
  if (identityToken) return identityToken;
  const apiKey = env.ZO_API_KEY?.trim();
  if (apiKey) return `Bearer ${apiKey}`;
  throw new Error("ZO_CLIENT_IDENTITY_TOKEN or ZO_API_KEY not set");
}

export function defaultSwarmPersonaRegistryPath(): string {
  return process.env.FACTORY_SWARM_PERSONA_REGISTRY
    ?? join(import.meta.dir, "..", "..", "..", "packages", "swarm", "assets", "persona-registry.json");
}

export function loadRegisteredPersonaNames(path = defaultSwarmPersonaRegistryPath()): string[] {
  if (!existsSync(path)) throw new Error(`swarm persona registry is unavailable: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { personas?: unknown };
  if (!Array.isArray(parsed.personas)) throw new Error(`swarm persona registry has no personas array: ${path}`);
  const names = parsed.personas.map((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { name?: unknown }).name !== "string") {
      throw new Error(`swarm persona registry entry ${index} has no name`);
    }
    return (entry as { name: string }).name;
  });
  if (new Set(names).size !== names.length) throw new Error("swarm persona registry contains duplicate persona names");
  return names;
}

function requiresSwarmRegistration(personaName: string): boolean {
  return REGISTERED_PERSONA_PREFIXES.some((prefix) => personaName.startsWith(prefix));
}

export async function invokeZoPersona(request: PersonaCallRequest): Promise<PersonaCallResult> {
  const authorization = resolvePersonaZoAskAuthorization();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeout_ms);
  try {
    const response = await fetch(ZO_ASK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization, connection: "close" },
      body: JSON.stringify(buildPersonaZoAskBody(request.input, request.model_name, request.persona_id)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`/zo/ask returned ${response.status}: ${await response.text()}`);
    const payload = await response.json() as Record<string, unknown>;
    const metadata = payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata as Record<string, unknown>
      : {};
    const usage = payload.usage && typeof payload.usage === "object"
      ? payload.usage as Record<string, unknown>
      : {};
    return {
      output: responseOutput(payload),
      model_name: typeof payload.model_name === "string"
        ? payload.model_name
        : typeof payload.model === "string"
          ? payload.model
          : request.model_name,
      cost_usd: finiteCost(payload.cost_usd) ?? finiteCost(usage.cost_usd) ?? finiteCost(metadata.cost_usd),
    };
  } finally {
    clearTimeout(timer);
  }
}

function pathContains(parent: string, child: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = normalize(parent);
  const c = normalize(child);
  return c === p || c.startsWith(`${p}/`);
}

function applicableRoles(
  association: SeedPersonaAssociation,
  item: WorkItem,
): Array<{ assignment: TaskPersonaAssignment; role: SeedPersonaFleetRole }> {
  const roleMap = new Map(association.fleet.map((role) => [role.role_id, role]));
  const applicable = (item.persona_assignments ?? []).map((assignment) => {
    const role = roleMap.get(assignment.role_id);
    if (!role) throw new Error(`task ${item.task_id} persona role ${assignment.role_id} is absent from association`);
    if (!role.phases.includes(assignment.authority)) {
      throw new Error(`task ${item.task_id} persona role ${assignment.role_id} exceeds association authority`);
    }
    if (assignment.authority === "implement") {
      if (assignment.owned_paths.length === 0) throw new Error(`task ${item.task_id} implement role ${assignment.role_id} has no owned paths`);
      for (const path of assignment.owned_paths) {
        if (!(item.owned_files ?? []).some((owned) => pathContains(owned, path))) {
          throw new Error(`task ${item.task_id} implement role ${assignment.role_id} escapes task-owned paths`);
        }
      }
    }
    return { assignment, role };
  });
  const maxCallsRaw = process.env.FACTORY_PERSONA_MAX_TASK_CALLS;
  const maxCalls = maxCallsRaw === undefined ? DEFAULT_MAX_TASK_CALLS : Number(maxCallsRaw);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) {
    throw new Error(`FACTORY_PERSONA_MAX_TASK_CALLS must be an integer from 1 to 64, got ${String(maxCallsRaw)}`);
  }
  if (applicable.length > maxCalls) throw new Error(`task ${item.task_id} persona fleet exceeds call cap ${maxCalls}`);
  const counts = new Map<string, number>();
  for (const { role } of applicable) counts.set(role.role_id, (counts.get(role.role_id) ?? 0) + 1);
  for (const { role } of applicable) {
    if ((counts.get(role.role_id) ?? 0) > role.invocation_cap) {
      throw new Error(`task ${item.task_id} role ${role.role_id} exceeds invocation cap ${role.invocation_cap}`);
    }
  }
  return applicable;
}

function blankEvidence(
  association: SeedPersonaAssociation,
  assignment: TaskPersonaAssignment,
  role: SeedPersonaFleetRole,
  persona: ResolvedPersona | null,
  snapshotHash: string | null,
  modelName: string,
  status: PersonaInvocationStatus,
  reason: string | null,
): PersonaInvocationEvidence {
  return {
    role_id: role.role_id,
    phase: assignment.authority,
    required: role.required,
    status,
    selector: role.persona_name,
    persona_id: persona?.persona_id ?? null,
    persona_name: persona?.name ?? null,
    scopes: persona ? [...persona.scopes] : [],
    owned_paths: [...assignment.owned_paths],
    association_version: association.version,
    association_sha256: association.sha256,
    directory_snapshot_hash: snapshotHash,
    model_name: modelName,
    resolved_model_name: null,
    harness: "zo-ask",
    invocation_key: null,
    requested_at: null,
    completed_at: null,
    prompt_sha256: null,
    result_sha256: null,
    artifact_ref: null,
    artifact_sha256: null,
    result_ref: null,
    cost_usd: null,
    reused: false,
    verdict: null,
    model_vendor: resolveModelVendor(modelName),
    implementer_model_name: null,
    implementer_vendor: null,
    distinct_model: null,
    vendor_diverse: null,
    reason,
  };
}

function advicePrompt(campaign: Campaign, item: WorkItem, evidence: PersonaInvocationEvidence): string {
  return [
    "You are a specialist advisor to an untrusted software-factory worker.",
    "Provide bounded technical advice only. Do not claim implementation, review, approval, or execution authority.",
    `Ticket: ${campaign.identifier}`,
    `Campaign/task: ${campaign.campaign_id}/${item.task_id}`,
    `Task: ${item.name}`,
    `Description: ${item.description}`,
    `Owned files: ${(item.owned_files ?? []).join(", ") || "none declared"}`,
    `Specialist role: ${evidence.role_id} (${evidence.persona_name})`,
    "Return concise risks, recommendations, and verification checks for this task.",
  ].join("\n");
}

function reviewPrompt(
  campaign: Campaign,
  item: WorkItem,
  evidence: PersonaInvocationEvidence,
  implementationSummary: string,
  deterministicSummary: string,
  targetRepo?: string,
): string {
  return [
    "You are a specialist critic providing untrusted review evidence after deterministic checks.",
    "Review only the assigned task and declared owned paths. Do not grant merge, deployment, or promotion authority.",
    `Ticket: ${campaign.identifier}`,
    `Campaign/task: ${campaign.campaign_id}/${item.task_id}`,
    `Task: ${item.name}`,
    ...(targetRepo ? [`Implementation worktree: ${targetRepo}`, "Inspect the implementation and diff in that worktree before returning a verdict."] : []),
    `Owned paths: ${evidence.owned_paths.join(", ") || "task-wide review"}`,
    `Implementation summary: ${implementationSummary.slice(0, 30_000)}`,
    `Deterministic result: ${deterministicSummary.slice(0, 10_000)}`,
    'Return strict JSON only: {"verdict":"pass"|"fail","summary":"..."}.',
  ].join("\n");
}

function parseReviewVerdict(output: string): { verdict: "pass" | "fail"; summary: string } {
  const text = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed.verdict !== "pass" && parsed.verdict !== "fail") throw new Error("persona review verdict must be pass|fail");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("persona review summary is required");
  return { verdict: parsed.verdict, summary: parsed.summary.trim() };
}

function artifactPath(dir: string, campaign: Campaign, item: WorkItem, key: string): string {
  return join(dir, safeSegment(campaign.campaign_id), safeSegment(item.task_id), `${key.slice(7)}.json`);
}

function evidenceFromArtifact(
  base: PersonaInvocationEvidence,
  artifact: InvocationArtifact,
  path: string,
  reused: boolean,
): PersonaInvocationEvidence {
  return {
    ...base,
    status: artifact.status === "success" ? "invoked" : base.required ? "blocked" : "not_invoked",
    invocation_key: artifact.invocation_key,
    requested_at: artifact.requested_at,
    completed_at: artifact.completed_at,
    prompt_sha256: artifact.prompt_sha256,
    result_sha256: artifact.result_sha256,
    artifact_ref: path,
    artifact_sha256: sha256(readFileSync(path)),
    result_ref: path,
    resolved_model_name: artifact.model_name,
    cost_usd: artifact.cost_usd,
    reused,
    verdict: artifact.verdict,
    reason: artifact.error,
  };
}

async function invokeEvidence(
  base: PersonaInvocationEvidence,
  prompt: string,
  campaign: Campaign,
  item: WorkItem,
  deps: Required<Pick<PersonaOrchestratorDeps, "invoke_persona" | "artifact_dir" | "timeout_ms" | "now">>,
): Promise<{ evidence: PersonaInvocationEvidence; output: string | null; new_cost_usd: number }> {
  if (!base.persona_id || !base.persona_name) throw new Error(`persona identity missing for ${base.role_id}`);
  const promptHash = sha256(prompt);
  const key = sha256([
    campaign.campaign_id,
    item.task_id,
    base.phase,
    base.role_id,
    base.persona_id,
    base.model_name,
    base.association_sha256,
    promptHash,
  ].join("\n"));
  const path = artifactPath(deps.artifact_dir, campaign, item, key);
  const readExisting = (): { evidence: PersonaInvocationEvidence; output: string | null; new_cost_usd: number } | null => {
    if (!existsSync(path)) return null;
    const artifact = JSON.parse(readFileSync(path, "utf8")) as InvocationArtifact;
    if (artifact.invocation_key !== key || artifact.prompt_sha256 !== promptHash) {
      throw new Error(`persona artifact key mismatch: ${path}`);
    }
    return { evidence: evidenceFromArtifact(base, artifact, path, true), output: artifact.output, new_cost_usd: 0 };
  };
  const existing = readExisting();
  if (existing) return existing;

  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + deps.timeout_ms;
  let lockFd: number | null = null;
  while (lockFd === null) {
    try {
      lockFd = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const completed = readExisting();
      if (completed) return completed;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for persona artifact lock: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    const raced = readExisting();
    if (raced) return raced;
    const requestedAt = deps.now();
    let artifact: InvocationArtifact;
    let callResult: PersonaCallResult | null = null;
    try {
      const result = await deps.invoke_persona({
        input: prompt,
        model_name: base.model_name,
        persona_id: base.persona_id,
        timeout_ms: deps.timeout_ms,
      });
      callResult = result;
      if (!result.output.trim()) throw new Error("persona returned empty output");
      let verdict: "pass" | "fail" | null = null;
      if (base.phase === "review") verdict = parseReviewVerdict(result.output).verdict;
      artifact = {
        version: 1,
        invocation_key: key,
        role_id: base.role_id,
        phase: base.phase,
        persona_id: base.persona_id,
        persona_name: base.persona_name,
        model_name: result.model_name || base.model_name,
        prompt_sha256: promptHash,
        status: "success",
        requested_at: requestedAt,
        completed_at: deps.now(),
        output: result.output,
        result_sha256: sha256(result.output),
        cost_usd: finiteCost(result.cost_usd),
        verdict,
        error: null,
      };
    } catch (error) {
      artifact = {
        version: 1,
        invocation_key: key,
        role_id: base.role_id,
        phase: base.phase,
        persona_id: base.persona_id,
        persona_name: base.persona_name,
        model_name: callResult?.model_name || base.model_name,
        prompt_sha256: promptHash,
        status: "failure",
        requested_at: requestedAt,
        completed_at: deps.now(),
        output: callResult?.output ?? null,
        result_sha256: callResult ? sha256(callResult.output) : null,
        cost_usd: finiteCost(callResult?.cost_usd),
        verdict: base.phase === "review" ? "fail" : null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    writeJsonAtomic(path, artifact);
    return {
      evidence: evidenceFromArtifact(base, artifact, path, false),
      output: artifact.output,
      new_cost_usd: artifact.cost_usd ?? 0,
    };
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // The immutable artifact remains authoritative if cleanup races or fails.
    }
  }
}

function resolvedFor(result: PersonaResolutionResult, roleId: string): ResolvedPersona | null {
  return result.resolved.find((persona) => persona.role_id === roleId) ?? null;
}

function resolutionReason(result: PersonaResolutionResult, roleId: string): string | null {
  return result.failures.find((failure) => failure.role_id === roleId || failure.role_id === "directory")?.message
    ?? result.omitted.find((omission) => omission.role_id === roleId)?.reason
    ?? (result.snapshot === null ? "persona directory unavailable" : null);
}

function requiredDeps(deps: PersonaOrchestratorDeps): Required<Pick<PersonaOrchestratorDeps, "invoke_persona" | "artifact_dir" | "timeout_ms" | "now">> {
  return {
    invoke_persona: deps.invoke_persona ?? invokeZoPersona,
    artifact_dir: resolveFactoryStateOverride(deps.artifact_dir, "pool", "persona-artifacts"),
    timeout_ms: deps.timeout_ms ?? personaTimeoutMs(),
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

export async function preparePersonaOrchestration(input: {
  campaign: Campaign;
  item: WorkItem;
  model_name: string;
  model_vendor?: string;
  main_transport_supports_persona: boolean;
  remaining_cost_usd: number;
  deps?: PersonaOrchestratorDeps;
}): Promise<PersonaPreparation> {
  const deps = input.deps ?? {};
  const mode = deps.mode ?? resolvePersonaOrchestrationMode();
  if (mode === "off" || !input.campaign.persona_association || !input.item.persona_assignments?.length) {
    return { record: null, advice: [], main_persona_id: null, main_owned_paths: [], new_cost_usd: 0, blocked_reason: null };
  }
  const association = input.campaign.persona_association;
  const applicable = applicableRoles(association, input.item);
  const clock = deps.now ?? (() => new Date().toISOString());
  const createdAt = clock();
  let registeredNames: Set<string>;
  let registryFailure: string | null = null;
  try {
    registeredNames = new Set(
      deps.registered_persona_names
        ?? loadRegisteredPersonaNames(deps.swarm_persona_registry_path),
    );
  } catch (error) {
    registeredNames = new Set();
    registryFailure = error instanceof Error ? error.message : String(error);
  }
  const unregistered = new Map(
    applicable
      .filter(({ role }) => requiresSwarmRegistration(role.persona_name) && !registeredNames.has(role.persona_name))
      .map(({ role }) => [
        role.role_id,
        registryFailure
          ? `swarm persona registration unavailable for ${role.persona_name}: ${registryFailure}`
          : `persona ${role.persona_name} is not registered in the swarm persona registry`,
      ]),
  );
  const requiredRegistrationFailure = applicable
    .filter(({ role }) => role.required)
    .map(({ role }) => unregistered.get(role.role_id) ?? null)
    .find((reason): reason is string => reason !== null) ?? null;
  const resolvable = applicable.filter(({ role }) => !unregistered.has(role.role_id));
  const resolution = requiredRegistrationFailure !== null && mode === "enforce"
    ? {
        ok: false,
        mode,
        snapshot: null,
        resolved: [],
        omitted: [],
        failures: [],
      } satisfies PersonaResolutionResult
    : await resolvePersonas({
        mode,
        roles: resolvable.map(({ role }) => ({
          role_id: role.role_id,
          selector: role.persona_name,
          required: role.required,
          required_scopes: role.required_scopes,
        })),
        listPersonas: deps.list_personas ?? createZoMcpListPersonasCaller(),
        timeoutMs: deps.timeout_ms ?? personaTimeoutMs(),
        now: createdAt,
      });
  const snapshotHash = resolution.snapshot?.snapshot_hash ?? null;
  let selectedReviewer: SpecialistReviewerSelection | null = null;
  let reviewerSelectionFailure: string | null = null;
  if (applicable.some(({ assignment }) => assignment.authority === "review")) {
    try {
      selectedReviewer = selectIndependentReviewerModel({
        implementerModelName: input.model_name,
        implementerVendor: input.model_vendor,
        policy: deps.reviewer_policy,
      });
    } catch (error) {
      reviewerSelectionFailure = error instanceof Error ? error.message : String(error);
    }
  }
  const invocations = applicable.map(({ assignment, role }) => {
    const registrationReason = unregistered.get(role.role_id) ?? null;
    if (registrationReason) {
      return blankEvidence(
        association,
        assignment,
        role,
        null,
        snapshotHash,
        input.model_name,
        mode === "enforce" && role.required ? "blocked" : "omitted",
        registrationReason,
      );
    }
    if (requiredRegistrationFailure !== null && mode === "enforce") {
      return blankEvidence(
        association,
        assignment,
        role,
        null,
        snapshotHash,
        input.model_name,
        role.required ? "blocked" : "not_invoked",
        `persona directory not queried because required registration failed: ${requiredRegistrationFailure}`,
      );
    }
    const persona = resolvedFor(resolution, role.role_id);
    const reason = resolutionReason(resolution, role.role_id);
    const status: PersonaInvocationStatus = persona
      ? mode === "shadow" ? "would_invoke" : "not_invoked"
      : mode === "enforce" && role.required ? "blocked" : mode === "shadow" && !reason ? "would_invoke" : "omitted";
    const reviewFailure = assignment.authority === "review" ? reviewerSelectionFailure : null;
    const evidence = blankEvidence(
      association,
      assignment,
      role,
      persona,
      snapshotHash,
      assignment.authority === "review" && selectedReviewer ? selectedReviewer.modelName : input.model_name,
      reviewFailure
        ? mode === "enforce" && role.required ? "blocked" : "omitted"
        : status,
      reviewFailure ?? reason,
    );
    if (assignment.authority === "review" && selectedReviewer) {
      evidence.model_vendor = selectedReviewer.vendor;
      evidence.implementer_model_name = selectedReviewer.implementerModelName;
      evidence.implementer_vendor = selectedReviewer.implementerVendor;
      evidence.distinct_model = selectedReviewer.distinctModel;
      evidence.vendor_diverse = selectedReviewer.vendorDiverse;
    }
    return evidence;
  });
  const record: PersonaOrchestrationRecord = {
    version: 1,
    campaign_id: input.campaign.campaign_id,
    task_id: input.item.task_id,
    mode,
    association: {
      template_reference: association.template_reference,
      version: association.version,
      sha256: association.sha256,
      content_fingerprint: association.content_fingerprint,
    },
    directory: {
      snapshot_hash: snapshotHash,
      captured_at: resolution.snapshot?.captured_at ?? null,
    },
    invocations,
    omitted_roles: [
      ...association.omitted_roles.map((role) => ({ ...role })),
      ...applicable
        .filter(({ role }) => unregistered.has(role.role_id))
        .map(({ role }) => ({ role_id: role.role_id, reason: unregistered.get(role.role_id)! })),
      ...resolution.omitted.map((role) => ({ role_id: role.role_id, reason: role.reason })),
    ],
    blocked_reason: null,
    total_cost_usd: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };

  if (requiredRegistrationFailure !== null && mode === "enforce") {
    record.blocked_reason = requiredRegistrationFailure;
    record.updated_at = clock();
    return { record, advice: [], main_persona_id: null, main_owned_paths: [], new_cost_usd: 0, blocked_reason: record.blocked_reason };
  }
  if (mode === "shadow") return { record, advice: [], main_persona_id: null, main_owned_paths: [], new_cost_usd: 0, blocked_reason: null };

  const requiredResolutionFailure = invocations.find((entry) => entry.required && !entry.persona_id);
  const requiredDirectoryFailure = resolution.failures.find((failure) => failure.required);
  const requiredPreflightFailure = invocations.find((entry) => entry.required && entry.status === "blocked");
  if (requiredResolutionFailure || requiredDirectoryFailure || requiredPreflightFailure) {
    record.blocked_reason = requiredPreflightFailure?.reason
      ?? requiredResolutionFailure?.reason
      ?? resolution.failures[0]?.message
      ?? "required persona resolution failed";
    record.updated_at = clock();
    return { record, advice: [], main_persona_id: null, main_owned_paths: [], new_cost_usd: 0, blocked_reason: record.blocked_reason };
  }

  const implement = invocations.filter((entry) => entry.phase === "implement" && entry.persona_id);
  if (implement.length > 1) {
    record.blocked_reason = "multiple resolved implement personas cannot bind to one main worker";
    for (const entry of implement) {
      entry.status = "blocked";
      entry.reason = record.blocked_reason;
    }
    record.updated_at = clock();
    return { record, advice: [], main_persona_id: null, main_owned_paths: [], new_cost_usd: 0, blocked_reason: record.blocked_reason };
  }
  if (implement.length === 1 && !input.main_transport_supports_persona) {
    record.blocked_reason = "selected harness cannot carry persona_id without changing harness routing";
    implement[0].status = "blocked";
    implement[0].reason = record.blocked_reason;
    record.updated_at = clock();
    return { record, advice: [], main_persona_id: null, main_owned_paths: [], new_cost_usd: 0, blocked_reason: record.blocked_reason };
  }

  const invokeDeps = requiredDeps(deps);
  const advice: PersonaAdviceInput[] = [];
  let newCost = 0;
  for (let index = 0; index < invocations.length; index++) {
    const entry = invocations[index];
    if (entry.phase !== "advise" || !entry.persona_id) continue;
    if (input.remaining_cost_usd - newCost <= 0) {
      entry.status = entry.required ? "blocked" : "not_invoked";
      entry.reason = "campaign cost ceiling exhausted before persona advisor call";
    } else {
      const invoked = await invokeEvidence(entry, advicePrompt(input.campaign, input.item, entry), input.campaign, input.item, invokeDeps);
      invocations[index] = invoked.evidence;
      newCost += invoked.new_cost_usd;
      if (invoked.evidence.status === "invoked" && invoked.output && invoked.evidence.artifact_ref) {
        advice.push({
          role_id: invoked.evidence.role_id,
          persona_name: invoked.evidence.persona_name!,
          artifact_ref: invoked.evidence.artifact_ref,
          content: invoked.output,
        });
      }
    }
    if (invocations[index].required && invocations[index].status !== "invoked") {
      record.blocked_reason = invocations[index].reason ?? `required advisor ${invocations[index].role_id} was not invoked`;
      break;
    }
  }
  if (newCost > input.remaining_cost_usd) record.blocked_reason = "persona advisor calls exceeded campaign cost ceiling";
  record.total_cost_usd += newCost;
  record.updated_at = clock();
  return {
    record,
    advice,
    main_persona_id: record.blocked_reason ? null : implement[0]?.persona_id ?? null,
    main_owned_paths: record.blocked_reason ? [] : [...(implement[0]?.owned_paths ?? [])],
    new_cost_usd: newCost,
    blocked_reason: record.blocked_reason,
  };
}

export function markMainWorkerPersona(
  record: PersonaOrchestrationRecord,
  input: { called: boolean; result_ref: string; response_text?: string; resolved_model_name?: string; reason?: string; now?: string },
): void {
  const implement = record.invocations.find((entry) => entry.phase === "implement" && entry.persona_id);
  if (!implement || record.mode !== "enforce") return;
  const now = input.now ?? new Date().toISOString();
  implement.requested_at ??= now;
  implement.completed_at = now;
  implement.status = input.called ? "invoked" : implement.required ? "blocked" : "not_invoked";
  implement.result_ref = input.result_ref;
  implement.result_sha256 = input.response_text ? sha256(input.response_text) : null;
  implement.resolved_model_name = input.called ? input.resolved_model_name ?? implement.model_name : null;
  implement.reason = input.reason ?? null;
  record.blocked_reason = implement.status === "blocked" ? implement.reason ?? "required implement persona was not invoked" : record.blocked_reason;
  record.updated_at = now;
}

export async function runPersonaReviews(input: {
  campaign: Campaign;
  item: WorkItem;
  record: PersonaOrchestrationRecord;
  implementation_summary: string;
  deterministic_pass: boolean;
  deterministic_summary: string;
  target_repo?: string;
  implementer_model_name: string;
  implementer_vendor?: string;
  remaining_cost_usd: number;
  deps?: PersonaOrchestratorDeps;
}): Promise<PersonaReviewGateResult> {
  const reviews = input.record.invocations.filter((entry) => entry.phase === "review");
  const requiredCount = reviews.filter((entry) => entry.required).length;
  if (input.record.mode === "shadow") {
    return {
      mode: "shadow",
      pass: true,
      required_count: requiredCount,
      invoked_count: 0,
      reviews,
      summary: `${reviews.length} persona review(s) would be invoked in enforce mode`,
      new_cost_usd: 0,
    };
  }
  if (input.record.mode === "off" || reviews.length === 0) {
    return { mode: input.record.mode, pass: true, required_count: 0, invoked_count: 0, reviews, summary: "no persona reviews required", new_cost_usd: 0 };
  }
  if (!input.deterministic_pass) {
    for (const review of reviews) {
      if (review.status === "not_invoked") review.reason = "deterministic review failed; critic call skipped";
    }
    input.record.updated_at = input.deps?.now?.() ?? new Date().toISOString();
    return {
      mode: "enforce",
      pass: requiredCount === 0,
      required_count: requiredCount,
      invoked_count: 0,
      reviews,
      summary: "persona critics skipped after deterministic failure",
      new_cost_usd: 0,
    };
  }

  const deps = requiredDeps(input.deps ?? {});
  let selectedReviewer: SpecialistReviewerSelection;
  try {
    selectedReviewer = selectIndependentReviewerModel({
      implementerModelName: input.implementer_model_name,
      implementerVendor: input.implementer_vendor,
      policy: input.deps?.reviewer_policy,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const review of reviews) {
      review.status = review.required ? "blocked" : "not_invoked";
      review.reason = reason;
    }
    input.record.blocked_reason = requiredCount > 0 ? reason : null;
    input.record.updated_at = deps.now();
    return {
      mode: "enforce",
      pass: requiredCount === 0,
      required_count: requiredCount,
      invoked_count: 0,
      reviews,
      summary: requiredCount > 0 ? reason : "no independent optional reviewer model available",
      new_cost_usd: 0,
    };
  }
  let newCost = 0;
  for (const review of reviews) {
    if (!review.persona_id) continue;
    review.model_name = selectedReviewer.modelName;
    review.model_vendor = selectedReviewer.vendor;
    review.implementer_model_name = selectedReviewer.implementerModelName;
    review.implementer_vendor = selectedReviewer.implementerVendor;
    review.distinct_model = selectedReviewer.distinctModel;
    review.vendor_diverse = selectedReviewer.vendorDiverse;
    if (input.remaining_cost_usd - newCost <= 0) {
      review.status = review.required ? "blocked" : "not_invoked";
      review.reason = "campaign cost ceiling exhausted before persona review";
      continue;
    }
    const invoked = await invokeEvidence(
      review,
      reviewPrompt(input.campaign, input.item, review, input.implementation_summary, input.deterministic_summary, input.target_repo),
      input.campaign,
      input.item,
      deps,
    );
    Object.assign(review, invoked.evidence);
    const servedModel = review.resolved_model_name ?? review.model_name;
    const servedVendor = resolveModelVendor(
      servedModel,
      servedModel === selectedReviewer.modelName ? selectedReviewer.vendor : undefined,
    );
    review.model_vendor = servedVendor;
    review.distinct_model = servedModel !== selectedReviewer.implementerModelName;
    review.vendor_diverse = servedVendor ? servedVendor !== selectedReviewer.implementerVendor : false;
    if (!review.distinct_model) {
      review.reason = `served specialist reviewer model ${servedModel} matches implementer model`;
    } else if (!review.vendor_diverse) {
      review.reason = servedVendor
        ? `served specialist reviewer vendor ${servedVendor} matches implementer vendor`
        : `served specialist reviewer vendor is unresolved for ${servedModel}`;
    }
    newCost += invoked.new_cost_usd;
  }
  const requiredFailures = reviews.filter((review) => review.required && (
    review.status !== "invoked"
    || review.verdict !== "pass"
    || review.distinct_model !== true
    || review.vendor_diverse !== true
  ));
  const pass = requiredFailures.length === 0 && newCost <= input.remaining_cost_usd;
  if (!pass) input.record.blocked_reason = requiredFailures[0]?.reason ?? `required persona review ${requiredFailures[0]?.role_id ?? "unknown"} did not pass`;
  input.record.total_cost_usd += newCost;
  input.record.updated_at = deps.now();
  return {
    mode: "enforce",
    pass,
    required_count: requiredCount,
    invoked_count: reviews.filter((review) => review.status === "invoked").length,
    reviews,
    summary: pass
      ? `${reviews.filter((review) => review.status === "invoked").length}/${reviews.length} persona reviews invoked; required reviews passed`
      : input.record.blocked_reason ?? "required persona review failed",
    new_cost_usd: newCost,
  };
}
