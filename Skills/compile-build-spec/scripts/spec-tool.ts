#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, normalize, resolve, sep } from "node:path";

type Origin = "source" | "proposed";
type Authority = "automated" | "agent" | "user" | "target-hardware";
type Decision = "PASS" | "HOLD" | "FAIL";

interface Provenanced {
  id: string;
  text: string;
  origin: Origin;
  sourceRefs: string[];
}

interface BuildSpec {
  schemaVersion: number;
  metadata: {
    project: string;
    version: string;
    date: string;
    owner: string;
    releaseTier: string;
    executionMode: "direct" | "swarm" | "undecided";
    source: { path: string; sha256: string; label: string };
    template?: {
      id: string;
      version: string;
      level: string;
      sha256: string;
      annexes: Array<{ id: string; version: string; sha256: string }>;
    };
  };
  mission: {
    statement: string;
    firstExperience: string;
    qualities: string[];
    releaseTier: string;
    excludedTier: string;
  };
  factory?: { targetRepo?: string; archetype?: string; area?: string };
  constraints: Provenanced[];
  antiGoals: Provenanced[];
  protectedCapabilities: Array<Provenanced & { requirementIds: string[] }>;
  scopeCutOrder: string[];
  decisions: Array<{
    id: string;
    question: string;
    options: string[];
    requiredEvidence: string;
    owner: string;
    status: "resolved" | "unresolved";
    resolution?: string;
  }>;
  contracts: Array<{
    id: string;
    name: string;
    canonicalLocation: string;
    consumers: string[];
    owner: string;
    invariants: string[];
  }>;
  requirements: Array<Provenanced & {
    type: "functional" | "nonfunctional";
    verificationIds: string[];
  }>;
  verifications: Array<{
    id: string;
    type: "static" | "unit" | "contract" | "integration" | "visual" | "temporal" | "performance" | "human";
    method: string;
    threshold: string;
    authority: Authority;
  }>;
  canonicalScenarios: Array<{
    id: string;
    name: string;
    setup: string;
    action: string;
    qualities: string[];
    evidence: string;
  }>;
  acceptanceCriteria: Array<Provenanced & {
    requirementIds: string[];
    verificationIds: string[];
    authority: Authority;
  }>;
  milestones: Array<{
    id: string;
    name: string;
    dependencies: string[];
    ownedPaths: string[];
    exitCriteria: string[];
    approval: "automated" | "agent" | "user";
    owner: string;
  }>;
  humanCriteria: Array<{
    id: string;
    question: string;
    scenarioIds: string[];
    approver: string;
  }>;
  deliverables: string[];
  outOfScope: string[];
  unresolved: Array<{ id: string; question: string; blocking: boolean; owner: string }>;
}

interface ValidationReport {
  valid: boolean;
  score: number;
  decision: Decision;
  errors: string[];
  warnings: string[];
  pendingDecisions: string[];
  unresolved: string[];
  categoryScores: Record<string, number>;
}

const ARCHETYPES = new Set(["dependency", "docs", "bugfix", "feature", "refactor", "migration"]);
const REVIEW_CRITERIA = "source-fidelity,requirement-completeness,technical-feasibility,falsifiability,architecture-coherence,scope-control,verification-quality,execution-safety";

function usage(exitCode = 1): never {
  process.stderr.write(`compile-build-spec

Commands:
  ingest --input FILE --output FILE
  validate --spec FILE [--source FILE]
  render --spec FILE --output FILE
  report --spec FILE --output FILE
  review --spec FILE --output FILE [--label TEXT] [--criteria CSV] [--dry-run]
  export-ticket --spec FILE --output FILE
  export-seed --spec FILE --output FILE
`);
  process.exit(exitCode);
}

function parseArgs(values: string[]): { command: string; flags: Map<string, string | true> } {
  const command = values[0];
  if (command === "--help" || command === "-h") usage(0);
  if (!command) usage();
  const flags = new Map<string, string | true>();
  for (let index = 1; index < values.length; index++) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) flags.set(token, true);
    else {
      flags.set(token, next);
      index++;
    }
  }
  return { command, flags };
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required flag ${name}`);
  return resolve(value);
}

function optionalFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function sha256(path: string): Promise<string> {
  const data = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(data)).digest("hex");
}

async function readJson<T>(path: string): Promise<T> {
  if (!(await Bun.file(path).exists())) throw new Error(`File does not exist: ${path}`);
  try {
    return JSON.parse(await Bun.file(path).text()) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeText(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function ticketText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function pathContains(parent: string, child: string): boolean {
  const parentNorm = normalize(parent).replace(/[\\/]+$/, "");
  const childNorm = normalize(child).replace(/[\\/]+$/, "");
  return childNorm === parentNorm || childNorm.startsWith(`${parentNorm}${sep}`);
}

function validateIdList(
  items: unknown[],
  label: string,
  pattern: RegExp,
  errors: string[],
  globalIds: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || !nonEmpty(item.id)) {
      errors.push(`${label}[${index}] is missing an id`);
      continue;
    }
    const id = item.id;
    ids.push(id);
    if (!pattern.test(id)) errors.push(`${label} id ${id} has an invalid format`);
    if (globalIds.has(id)) errors.push(`Duplicate id: ${id}`);
    globalIds.add(id);
  }
  return ids;
}

function validateProvenance(items: unknown[], label: string, errors: string[]): void {
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) {
      errors.push(`${label}[${index}] must be an object`);
      continue;
    }
    if (!nonEmpty(item.text)) errors.push(`${label} ${String(item.id ?? index)} is missing text`);
    if (item.origin !== "source" && item.origin !== "proposed") {
      errors.push(`${label} ${String(item.id ?? index)} has invalid origin`);
    }
    const refs = asArray(item.sourceRefs).filter(nonEmpty);
    if (item.origin === "source" && refs.length === 0) {
      errors.push(`${label} ${String(item.id ?? index)} is source-derived but has no sourceRefs`);
    }
    for (const ref of refs) {
      if (!/^source:L\d+(?:-L\d+)?$/.test(ref)) errors.push(`${label} ${String(item.id ?? index)} has invalid sourceRef ${ref}`);
    }
  }
}

function detectCycle(milestones: BuildSpec["milestones"]): string | null {
  const deps = new Map(milestones.map((milestone) => [milestone.id, milestone.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): string | null => {
    if (visiting.has(id)) return id;
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const dependency of deps.get(id) ?? []) {
      const cycle = walk(dependency);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of deps.keys()) {
    const cycle = walk(id);
    if (cycle) return cycle;
  }
  return null;
}

function dependsOn(
  milestones: Map<string, BuildSpec["milestones"][number]>,
  start: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(start)) return false;
  seen.add(start);
  for (const dependency of milestones.get(start)?.dependencies ?? []) {
    if (dependency === target || dependsOn(milestones, dependency, target, seen)) return true;
  }
  return false;
}

export function validateSpec(spec: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const globalIds = new Set<string>();
  if (!isRecord(spec)) {
    return {
      valid: false,
      score: 0,
      decision: "FAIL",
      errors: ["Specification must be a JSON object"],
      warnings,
      pendingDecisions: [],
      unresolved: [],
      categoryScores: {},
    };
  }

  if (spec.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  const metadata = isRecord(spec.metadata) ? spec.metadata : {};
  const mission = isRecord(spec.mission) ? spec.mission : {};
  for (const field of ["project", "version", "date", "owner", "releaseTier", "executionMode"]) {
    if (!nonEmpty(metadata[field])) errors.push(`metadata.${field} is required`);
  }
  const source = isRecord(metadata.source) ? metadata.source : {};
  for (const field of ["path", "sha256", "label"]) {
    if (!nonEmpty(source[field])) errors.push(`metadata.source.${field} is required`);
  }
  if (nonEmpty(source.sha256) && !/^[a-f0-9]{64}$/.test(source.sha256)) errors.push("metadata.source.sha256 must be lowercase SHA-256");
  if (metadata.template !== undefined) {
    const template = isRecord(metadata.template) ? metadata.template : {};
    for (const field of ["id", "version", "level", "sha256"]) {
      if (!nonEmpty(template[field])) errors.push(`metadata.template.${field} is required`);
    }
    if (nonEmpty(template.version) && !/^\d+\.\d+\.\d+$/.test(template.version)) errors.push("metadata.template.version must be exact semantic version");
    if (nonEmpty(template.sha256) && !/^[a-f0-9]{64}$/.test(template.sha256)) errors.push("metadata.template.sha256 must be lowercase SHA-256");
    for (const [index, annexValue] of asArray(template.annexes).entries()) {
      const annex = isRecord(annexValue) ? annexValue : {};
      for (const field of ["id", "version", "sha256"]) {
        if (!nonEmpty(annex[field])) errors.push(`metadata.template.annexes[${index}].${field} is required`);
      }
      if (nonEmpty(annex.version) && !/^\d+\.\d+\.\d+$/.test(annex.version)) errors.push(`metadata.template.annexes[${index}].version must be exact semantic version`);
      if (nonEmpty(annex.sha256) && !/^[a-f0-9]{64}$/.test(annex.sha256)) errors.push(`metadata.template.annexes[${index}].sha256 must be lowercase SHA-256`);
    }
  }
  for (const field of ["statement", "firstExperience", "releaseTier", "excludedTier"]) {
    if (!nonEmpty(mission[field])) errors.push(`mission.${field} is required`);
  }

  const constraints = asArray(spec.constraints);
  const antiGoals = asArray(spec.antiGoals);
  const protectedCapabilities = asArray(spec.protectedCapabilities);
  const decisions = asArray(spec.decisions);
  const contracts = asArray(spec.contracts);
  const requirements = asArray(spec.requirements);
  const verifications = asArray(spec.verifications);
  const scenarios = asArray(spec.canonicalScenarios);
  const acceptance = asArray(spec.acceptanceCriteria);
  const milestones = asArray(spec.milestones);
  const humanCriteria = asArray(spec.humanCriteria);

  validateIdList(constraints, "constraints", /^C-\d{3}$/, errors, globalIds);
  validateIdList(antiGoals, "antiGoals", /^AG-\d{3}$/, errors, globalIds);
  validateIdList(protectedCapabilities, "protectedCapabilities", /^PC-\d{3}$/, errors, globalIds);
  validateIdList(decisions, "decisions", /^D-\d{3}$/, errors, globalIds);
  const contractIds = new Set(validateIdList(contracts, "contracts", /^SC-\d{3}$/, errors, globalIds));
  const requirementIds = new Set(validateIdList(requirements, "requirements", /^(FR|NFR)-\d{3}$/, errors, globalIds));
  const verificationIds = new Set(validateIdList(verifications, "verifications", /^V-\d{3}$/, errors, globalIds));
  const scenarioIds = new Set(validateIdList(scenarios, "canonicalScenarios", /^CS-\d{3}$/, errors, globalIds));
  const acceptanceIds = new Set(validateIdList(acceptance, "acceptanceCriteria", /^AC-\d{3}$/, errors, globalIds));
  const milestoneIds = new Set(validateIdList(milestones, "milestones", /^M\d+$/, errors, globalIds));
  validateIdList(humanCriteria, "humanCriteria", /^HC-\d{3}$/, errors, globalIds);

  validateProvenance(constraints, "constraint", errors);
  validateProvenance(antiGoals, "anti-goal", errors);
  validateProvenance(protectedCapabilities, "protected capability", errors);
  validateProvenance(requirements, "requirement", errors);
  validateProvenance(acceptance, "acceptance criterion", errors);

  if (constraints.length === 0) errors.push("At least one constraint is required");
  if (requirements.length === 0) errors.push("At least one requirement is required");
  if (verifications.length === 0) errors.push("At least one verification is required");
  if (acceptance.length === 0) errors.push("At least one acceptance criterion is required");
  if (milestones.length === 0) errors.push("At least one milestone is required");
  if (asArray(spec.deliverables).filter(nonEmpty).length === 0) errors.push("At least one deliverable is required");

  for (const item of requirements) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    const refs = asArray(item.verificationIds).filter(nonEmpty);
    if (refs.length === 0) errors.push(`Requirement ${item.id} has no verificationIds`);
    for (const ref of refs) if (!verificationIds.has(ref)) errors.push(`Requirement ${item.id} references unknown verification ${ref}`);
  }

  for (const item of acceptance) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    const reqRefs = asArray(item.requirementIds).filter(nonEmpty);
    const verifyRefs = asArray(item.verificationIds).filter(nonEmpty);
    if (reqRefs.length === 0) errors.push(`Acceptance criterion ${item.id} has no requirementIds`);
    if (verifyRefs.length === 0) errors.push(`Acceptance criterion ${item.id} has no verificationIds`);
    for (const ref of reqRefs) if (!requirementIds.has(ref)) errors.push(`Acceptance criterion ${item.id} references unknown requirement ${ref}`);
    for (const ref of verifyRefs) if (!verificationIds.has(ref)) errors.push(`Acceptance criterion ${item.id} references unknown verification ${ref}`);
  }

  for (const item of protectedCapabilities) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    const refs = asArray(item.requirementIds).filter(nonEmpty);
    if (refs.length === 0) errors.push(`Protected capability ${item.id} has no requirementIds`);
    for (const ref of refs) {
      if (!requirementIds.has(ref)) errors.push(`Protected capability ${item.id} references unknown requirement ${ref}`);
      const covered = acceptance.some((criterion) => isRecord(criterion) && asArray(criterion.requirementIds).includes(ref));
      if (!covered) errors.push(`Protected capability ${item.id} requirement ${ref} has no acceptance coverage`);
    }
  }

  for (const item of contracts) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    for (const field of ["name", "canonicalLocation", "owner"]) {
      if (!nonEmpty(item[field])) errors.push(`Contract ${item.id} is missing ${field}`);
    }
    if (asArray(item.consumers).filter(nonEmpty).length < 2) warnings.push(`Contract ${item.id} has fewer than two consumers`);
    if (asArray(item.invariants).filter(nonEmpty).length === 0) errors.push(`Contract ${item.id} has no invariants`);
  }

  for (const item of decisions) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    for (const field of ["question", "requiredEvidence", "owner"]) {
      if (!nonEmpty(item[field])) errors.push(`Decision ${item.id} is missing ${field}`);
    }
    if (asArray(item.options).filter(nonEmpty).length === 0) errors.push(`Decision ${item.id} must provide at least one option`);
    if (item.status !== "resolved" && item.status !== "unresolved") errors.push(`Decision ${item.id} has invalid status`);
    if (item.status === "resolved" && !nonEmpty(item.resolution)) errors.push(`Decision ${item.id} is resolved without a resolution`);
  }

  const verificationKinds = new Set(["static", "unit", "contract", "integration", "visual", "temporal", "performance", "human"]);
  const authorities = new Set(["automated", "agent", "user", "target-hardware"]);
  for (const item of verifications) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    if (!verificationKinds.has(String(item.type))) errors.push(`Verification ${item.id} has invalid type`);
    if (!nonEmpty(item.method)) errors.push(`Verification ${item.id} is missing method`);
    if (!nonEmpty(item.threshold)) errors.push(`Verification ${item.id} is missing threshold`);
    if (!authorities.has(String(item.authority))) errors.push(`Verification ${item.id} has invalid authority`);
  }

  for (const item of scenarios) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    for (const field of ["name", "setup", "action", "evidence"]) {
      if (!nonEmpty(item[field])) errors.push(`Scenario ${item.id} is missing ${field}`);
    }
    if (asArray(item.qualities).filter(nonEmpty).length === 0) errors.push(`Scenario ${item.id} has no quality targets`);
  }

  for (const item of acceptance) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    if (!authorities.has(String(item.authority))) errors.push(`Acceptance criterion ${item.id} has invalid authority`);
  }

  const typedMilestones = milestones.filter(isRecord) as unknown as BuildSpec["milestones"];
  for (const milestone of typedMilestones) {
    if (!nonEmpty(milestone.name) || !nonEmpty(milestone.owner)) errors.push(`Milestone ${milestone.id} is missing name or owner`);
    if (asArray(milestone.ownedPaths).filter(nonEmpty).length === 0) errors.push(`Milestone ${milestone.id} has no owned paths`);
    if (asArray(milestone.exitCriteria).filter(nonEmpty).length === 0) errors.push(`Milestone ${milestone.id} has no exit criteria`);
    if (!nonEmpty(milestone.approval)) errors.push(`Milestone ${milestone.id} is missing approval authority`);
    for (const dependency of asArray(milestone.dependencies).filter(nonEmpty)) {
      if (!milestoneIds.has(dependency)) errors.push(`Milestone ${milestone.id} references unknown dependency ${dependency}`);
    }
    for (const criterion of asArray(milestone.exitCriteria).filter(nonEmpty)) {
      if (!acceptanceIds.has(criterion)) errors.push(`Milestone ${milestone.id} references unknown exit criterion ${criterion}`);
    }
  }
  const cycle = detectCycle(typedMilestones);
  if (cycle) errors.push(`Milestone DAG contains a cycle at ${cycle}`);

  const milestoneMap = new Map(typedMilestones.map((milestone) => [milestone.id, milestone]));
  for (let left = 0; left < typedMilestones.length; left++) {
    for (let right = left + 1; right < typedMilestones.length; right++) {
      const a = typedMilestones[left];
      const b = typedMilestones[right];
      if (dependsOn(milestoneMap, a.id, b.id) || dependsOn(milestoneMap, b.id, a.id)) continue;
      for (const aPath of asArray(a.ownedPaths).filter(nonEmpty)) {
        for (const bPath of asArray(b.ownedPaths).filter(nonEmpty)) {
          if (pathContains(aPath, bPath) || pathContains(bPath, aPath)) {
            errors.push(`Unordered milestones ${a.id} and ${b.id} have overlapping owned paths: ${aPath}, ${bPath}`);
          }
        }
      }
    }
  }

  for (const item of humanCriteria) {
    if (!isRecord(item) || !nonEmpty(item.id)) continue;
    if (!nonEmpty(item.question) || !nonEmpty(item.approver)) errors.push(`Human criterion ${item.id} is incomplete`);
    for (const ref of asArray(item.scenarioIds).filter(nonEmpty)) {
      if (!scenarioIds.has(ref)) errors.push(`Human criterion ${item.id} references unknown scenario ${ref}`);
    }
  }

  const pendingDecisions = decisions.flatMap((item) =>
    isRecord(item) && item.status !== "resolved" ? [String(item.id ?? "unknown")] : [],
  );
  const unresolved = asArray(spec.unresolved).flatMap((item) =>
    isRecord(item) && item.blocking !== false ? [String(item.id ?? item.question ?? "unknown")] : [],
  );

  const allAcceptanceLinked = acceptance.length > 0 && acceptance.every((item) =>
    isRecord(item) && asArray(item.requirementIds).length > 0 && asArray(item.verificationIds).length > 0,
  );
  const allRequirementsVerified = requirements.length > 0 && requirements.every((item) =>
    isRecord(item) && asArray(item.verificationIds).length > 0,
  );
  const verificationTypes = new Set(verifications.filter(isRecord).map((item) => item.type));
  const categoryScores = {
    productClarity: nonEmpty(mission.statement) && nonEmpty(mission.firstExperience) && asArray(mission.qualities).filter(nonEmpty).length >= 3 ? 15 : 0,
    feasibility: pendingDecisions.length === 0 ? 15 : 5,
    falsifiability: allAcceptanceLinked ? 20 : 0,
    architectureCoherence: contractIds.size > 0 ? 15 : 0,
    scopeControl: protectedCapabilities.length > 0 && asArray(spec.scopeCutOrder).filter(nonEmpty).length > 0 ? 10 : 0,
    executionSafety: typedMilestones.length > 0 && !cycle ? 10 : 0,
    verificationDepth: allRequirementsVerified && verificationTypes.has("static") && (verificationTypes.has("integration") || verificationTypes.has("contract")) ? 15 : 5,
  };
  const score = Object.values(categoryScores).reduce((sum, value) => sum + value, 0);
  const valid = errors.length === 0;
  const decision: Decision = !valid ? "FAIL" : score < 80 || pendingDecisions.length > 0 || unresolved.length > 0 ? "HOLD" : "PASS";
  if (score < 80) warnings.push(`Preflight score ${score} is below 80`);
  if (pendingDecisions.length > 0) warnings.push(`Pending decisions: ${pendingDecisions.join(", ")}`);
  if (unresolved.length > 0) warnings.push(`Blocking unresolved items: ${unresolved.join(", ")}`);

  return { valid, score, decision, errors, warnings, pendingDecisions, unresolved, categoryScores };
}

function markdownList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None";
}

function renderProvenanced(items: Provenanced[]): string {
  return items.map((item) => `- **${item.id}** [${item.origin}]: ${item.text}`).join("\n") || "- None";
}

export function renderSpec(spec: BuildSpec): string {
  const requirementRows = spec.requirements.map((item) =>
    `| ${item.id} | ${item.type} | ${item.origin} | ${item.text} | ${item.verificationIds.join(", ")} |`,
  ).join("\n");
  const acceptanceRows = spec.acceptanceCriteria.map((item) =>
    `| ${item.id} | ${item.text} | ${item.requirementIds.join(", ")} | ${item.verificationIds.join(", ")} | ${item.authority} |`,
  ).join("\n");
  const milestoneRows = spec.milestones.map((item) =>
    `| ${item.id} | ${item.name} | ${item.dependencies.join(", ") || "None"} | ${item.ownedPaths.join(", ")} | ${item.exitCriteria.join(", ")} | ${item.approval} |`,
  ).join("\n");
  return `# ${spec.metadata.project} Build Specification

Version: ${spec.metadata.version}  
Date: ${spec.metadata.date}  
Owner: ${spec.metadata.owner}  
Execution mode: ${spec.metadata.executionMode}

## Source Provenance

- Label: ${spec.metadata.source.label}
- Path: \`${spec.metadata.source.path}\`
- SHA-256: \`${spec.metadata.source.sha256}\`
${spec.metadata.template ? `
## Template Lineage

- Template: \`${spec.metadata.template.id}@${spec.metadata.template.version}\`
- Level: \`${spec.metadata.template.level}\`
- SHA-256: \`${spec.metadata.template.sha256}\`
- Annexes: ${spec.metadata.template.annexes.map((item) => `\`${item.id}@${item.version}\` (\`${item.sha256}\`)`).join(", ") || "None"}
` : ""}

## Mission

${spec.mission.statement}

First experience: ${spec.mission.firstExperience}

Qualities: ${spec.mission.qualities.join(", ")}

Release tier: ${spec.mission.releaseTier}; excluded tier: ${spec.mission.excludedTier}

## Constraints

${renderProvenanced(spec.constraints)}

## Anti-Goals

${renderProvenanced(spec.antiGoals)}

## Protected Capabilities

${renderProvenanced(spec.protectedCapabilities)}

## Scope Cut Order

${markdownList(spec.scopeCutOrder)}

## Shared Contracts

${spec.contracts.map((item) => `- **${item.id} ${item.name}**: \`${item.canonicalLocation}\`; owner ${item.owner}; consumers ${item.consumers.join(", ")}; invariants ${item.invariants.join("; ")}`).join("\n") || "- None"}

## Requirements

| ID | Type | Origin | Requirement | Verification |
|---|---|---|---|---|
${requirementRows}

## Verification

${spec.verifications.map((item) => `- **${item.id}** (${item.type}, ${item.authority}): ${item.method}. Threshold: ${item.threshold}`).join("\n")}

## Canonical Scenarios

${spec.canonicalScenarios.map((item) => `- **${item.id} ${item.name}**: ${item.setup}; ${item.action}. Evidence: ${item.evidence}`).join("\n") || "- None"}

## Acceptance Matrix

| ID | Criterion | Requirements | Verification | Authority |
|---|---|---|---|---|
${acceptanceRows}

## Milestones

| ID | Increment | Dependencies | Owned Paths | Exit Criteria | Approval |
|---|---|---|---|---|---|
${milestoneRows}

## Human Review

${spec.humanCriteria.map((item) => `- **${item.id}** (${item.approver}): ${item.question} Scenarios: ${item.scenarioIds.join(", ")}`).join("\n") || "- None"}

## Deliverables

${markdownList(spec.deliverables)}

## Out of Scope

${markdownList(spec.outOfScope)}

## Unresolved

${spec.unresolved.map((item) => `- **${item.id}** (${item.owner}${item.blocking ? ", blocking" : ""}): ${item.question}`).join("\n") || "- None"}
`;
}

function assertFactoryReady(spec: BuildSpec, report: ValidationReport): Required<NonNullable<BuildSpec["factory"]>> {
  if (report.decision !== "PASS") throw new Error(`Factory export requires deterministic PASS; current decision is ${report.decision}`);
  const factory = spec.factory ?? {};
  if (!nonEmpty(factory.targetRepo) || !nonEmpty(factory.archetype) || !nonEmpty(factory.area)) {
    throw new Error("Factory export requires targetRepo, archetype, and area");
  }
  if (!ARCHETYPES.has(factory.archetype)) throw new Error(`Unsupported factory archetype: ${factory.archetype}`);
  const repoSegments = factory.targetRepo.split(/[\\/]/);
  if (factory.targetRepo.startsWith("/") || factory.targetRepo.startsWith("\\") || /^[A-Za-z]:/.test(factory.targetRepo) || repoSegments.includes("..")) {
    throw new Error("Factory targetRepo must be a contained workspace-relative path");
  }
  return factory as Required<NonNullable<BuildSpec["factory"]>>;
}

export function renderFactoryTicket(spec: BuildSpec, report: ValidationReport): string {
  const factory = assertFactoryReady(spec, report);
  return `## Goal
${ticketText(spec.mission.statement)}

## Acceptance Criteria
${spec.acceptanceCriteria.map((item) => `- [${item.id}] ${ticketText(item.text)}`).join("\n")}

## Target Repo
${factory.targetRepo}

## Archetype
${factory.archetype}

## Repro
${ticketText(factory.area)}

## Authority
Candidate generation does not grant factory-ready, dispatch, merge, migration, deployment, publication, or courseware-release authority. Each action requires explicit human promotion through its governing system.

## Source Provenance
- Source: ${ticketText(spec.metadata.source.label)}
- SHA-256: ${spec.metadata.source.sha256}
- Build spec version: ${spec.metadata.version}
${spec.metadata.template ? `
## Template Lineage
- Template: ${ticketText(spec.metadata.template.id)}@${ticketText(spec.metadata.template.version)}
- Level: ${ticketText(spec.metadata.template.level)}
- SHA-256: ${spec.metadata.template.sha256}
- Annexes: ${spec.metadata.template.annexes.map((item) => `${ticketText(item.id)}@${ticketText(item.version)} (${item.sha256})`).join(", ") || "None"}
` : ""}
`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: string[], indent = 0): string {
  const pad = " ".repeat(indent);
  return values.length > 0 ? values.map((value) => `${pad}- ${yamlString(value)}`).join("\n") : `${pad}[]`;
}

export function renderFactorySeed(spec: BuildSpec, report: ValidationReport): string {
  const factory = assertFactoryReady(spec, report);
  const slug = spec.metadata.project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dag = spec.milestones.map((item) => `  ${item.id}: [${item.dependencies.join(", ")}]`).join("\n");
  const tasks = spec.milestones.map((item) => `  - id: ${item.id}
    name: ${yamlString(item.name)}
    owner: ${yamlString(item.owner)}
    files:
${yamlList(item.ownedPaths, 6)}
    change: ${yamlString(`Satisfy exit criteria ${item.exitCriteria.join(", ")}`)}
    deps: [${item.dependencies.join(", ")}]`).join("\n");
  return `schema_version: 1
id: ${yamlString(`seed-${slug}-${spec.metadata.source.sha256.slice(0, 8)}`)}
created: ${yamlString(spec.metadata.date)}
title: ${yamlString(spec.metadata.project)}
source_hash: ${yamlString(spec.metadata.source.sha256)}
${spec.metadata.template ? `template_id: ${yamlString(spec.metadata.template.id)}
template_version: ${yamlString(spec.metadata.template.version)}
template_level: ${yamlString(spec.metadata.template.level)}
template_hash: ${yamlString(spec.metadata.template.sha256)}
template_annexes:
${yamlList(spec.metadata.template.annexes.map((item) => `${item.id}@${item.version}:${item.sha256}`), 2)}
` : ""}authority: ${yamlString("Candidate generation does not grant factory-ready, dispatch, merge, migration, deployment, publication, or courseware-release authority. Each action requires explicit human promotion through its governing system.")}
goal: ${yamlString(spec.mission.statement)}
archetype: ${yamlString(factory.archetype)}
target_repo: ${yamlString(factory.targetRepo)}
constraints:
${yamlList(spec.constraints.map((item) => item.text), 2)}
tasks:
${tasks}
acceptance_criteria:
${yamlList(spec.acceptanceCriteria.map((item) => `[${item.id}] ${item.text}`), 2)}
dag:
${dag}
out_of_scope:
${yamlList(spec.outOfScope, 2)}
evaluation_principles:
  - name: correctness
    description: ${yamlString("All linked acceptance criteria pass with retained evidence")}
    weight: 0.4
  - name: verification
    description: ${yamlString("Production and evaluation paths remain equivalent")}
    weight: 0.35
  - name: scope_control
    description: ${yamlString("Protected capabilities remain intact and exclusions are respected")}
    weight: 0.25
exit_conditions:
  - name: all_acceptance_met
    description: ${yamlString("All acceptance criteria have evidence")}
    criteria: ${yamlString("AC compliance = 100%; no critical or high defects")}
`;
}

function conversionReport(spec: BuildSpec, validation: ValidationReport): string {
  const provenanced = [
    ...spec.constraints,
    ...spec.antiGoals,
    ...spec.protectedCapabilities,
    ...spec.requirements,
    ...spec.acceptanceCriteria,
  ];
  const sourceCount = provenanced.filter((item) => item.origin === "source").length;
  const proposedCount = provenanced.filter((item) => item.origin === "proposed").length;
  return `# ${spec.metadata.project} Conversion Report

- Source SHA-256: \`${spec.metadata.source.sha256}\`
- Source-derived items: ${sourceCount}
- Proposed items: ${proposedCount}
- Intentionally out of scope: ${spec.outOfScope.length}
- Pending decisions: ${validation.pendingDecisions.length}
- Blocking unresolved items: ${validation.unresolved.length}
- Preflight score: ${validation.score}/100
- Decision: **${validation.decision}**

## Pending Decisions

${markdownList(validation.pendingDecisions)}

## Unresolved

${markdownList(spec.unresolved.map((item) => `${item.id}: ${item.question}`))}

## Proposed Additions

${renderProvenanced(provenanced.filter((item) => item.origin === "proposed"))}

## Intentional Exclusions

${markdownList(spec.outOfScope)}
`;
}

async function validateSource(spec: BuildSpec, sourcePath: string, report: ValidationReport): Promise<void> {
  const actual = await sha256(sourcePath);
  if (actual !== spec.metadata.source.sha256) {
    report.valid = false;
    report.decision = "FAIL";
    report.errors.push(`Source hash mismatch: expected ${spec.metadata.source.sha256}, got ${actual}`);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  if (command === "ingest") {
    const input = requiredFlag(flags, "--input");
    const output = requiredFlag(flags, "--output");
    const text = await Bun.file(input).text();
    const manifest = {
      schemaVersion: 1,
      source: {
        path: input,
        label: basename(input),
        sha256: await sha256(input),
        bytes: new TextEncoder().encode(text).byteLength,
        lines: text.split(/\r?\n/).length,
      },
    };
    await writeText(output, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }

  const specPath = requiredFlag(flags, "--spec");
  const spec = await readJson<BuildSpec>(specPath);
  const report = validateSpec(spec);
  const sourcePath = optionalFlag(flags, "--source");
  if (sourcePath) await validateSource(spec, resolve(sourcePath), report);

  if (command === "validate") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.decision === "PASS" ? 0 : report.decision === "HOLD" ? 2 : 1;
    return;
  }

  const output = requiredFlag(flags, "--output");
  if (command === "render") {
    if (!report.valid) throw new Error(`Cannot render invalid spec: ${report.errors.join("; ")}`);
    await writeText(output, renderSpec(spec));
    return;
  }
  if (command === "report") {
    await writeText(output, conversionReport(spec, report));
    return;
  }
  if (command === "export-ticket") {
    await writeText(output, renderFactoryTicket(spec, report));
    return;
  }
  if (command === "export-seed") {
    await writeText(output, renderFactorySeed(spec, report));
    return;
  }
  if (command === "review") {
    const label = optionalFlag(flags, "--label") ?? `${spec.metadata.project}-build-spec`;
    const criteria = optionalFlag(flags, "--criteria") ?? REVIEW_CRITERIA;
    const request = {
      artifact: spec,
      artifact_sha256: createHash("sha256").update(canonicalJson(spec)).digest("hex"),
      revision: 1,
      gate_run_id: label,
      criteria,
      deterministic_validation: report,
    };
    if (flags.has("--dry-run")) {
      await writeText(output, `${JSON.stringify(request, null, 2)}\n`);
      return;
    }
    if (!report.valid) throw new Error(`Consensus review refused invalid spec: ${report.errors.join("; ")}`);
    try {
      const reviewModulePath = "../../consensus-gate/scripts/plan-consensus-gate.ts";
      const { PlanConsensus } = await import(reviewModulePath);
      const gate = new PlanConsensus({ label, criteria, inputFormat: "json" });
      const consensus = await gate.evaluate(JSON.stringify(spec));
      const decision = consensus.status === "rejected" ? "REVISE" : consensus.status === "passed" && report.decision === "PASS" ? "PASS" : "HOLD";
      await writeText(output, `${JSON.stringify({ decision, deterministic: report, consensus }, null, 2)}\n`);
      process.exitCode = decision === "PASS" ? 0 : 2;
    } catch (error) {
      const result = {
        decision: "HOLD",
        deterministic: report,
        consensus: null,
        error: error instanceof Error ? error.message : String(error),
      };
      await writeText(output, `${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 2;
    }
    return;
  }
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
