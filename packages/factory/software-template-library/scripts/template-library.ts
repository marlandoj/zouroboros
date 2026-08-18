#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import templateLibrarySchema from "../schema/template-library.schema.json";
import {
  type PersonaAssociationMeta,
  type PersonaPhase,
  type TaskPersonaAssignment,
  renderFactorySeed,
  renderFactoryTicket,
  renderSpec,
  validateSpec,
} from "../../../Skills/compile-build-spec/scripts/spec-tool";
import {
  loadAssociationRegistry,
  resolvePersonaAssociation,
  type PersonaAssociationRegistry,
  type SelectorDimension,
} from "./persona-associations";

export type DetailLevelId = "starter" | "standard" | "factory";
export type ExecutionMode = "direct" | "swarm" | "undecided";

export interface DetailLevel {
  id: DetailLevelId;
  description: string;
  supportedExecutionModes: ExecutionMode[];
  requiredSections: string[];
  additionalDecisions: string[];
  verificationTypes: string[];
}

export interface Annex {
  id: string;
  version: string;
  description: string;
  requires: string[];
  incompatibleAnnexes: string[];
  incompatibleAssumptions: string[];
  decisions: string[];
  requirements: string[];
  verifications: string[];
}

export interface CategoryTemplate {
  id: string;
  version: string;
  category: string;
  definition: string;
  examples: string[];
  counterexample: string;
  tags: string[];
  emphasis: string[];
  nonGoals: string[];
  requiredDecisions: string[];
  requirements: string[];
  verifications: string[];
  recommendedAnnexes: string[];
  supportedExecutionModes: ExecutionMode[];
}

export interface TemplateLibrary {
  schemaVersion: number;
  catalogVersion: string;
  status: "draft" | "validated" | "reviewed" | "published" | "deprecated";
  owner: string;
  resolutionContract: {
    version: string;
    hashAlgorithm: "sha256-canonical-json";
    hashInput: string;
    hashOutput: string;
    baseTemplateCount: 1;
    mergeOrder: ["category", "detail-level", "annexes-in-declared-order", "user-answers"];
    arrayPolicy: "append-unique";
    conflictPolicy: "fail-closed";
    rules: string[];
  };
  exportContract: {
    version: string;
    artifactKinds: string[];
    candidateOnly: true;
    requiredValidationDecision: "PASS";
    requiredLineage: string[];
    ticketHeaders: string[];
    prohibitedAuthorities: string[];
    failurePolicy: string;
  };
  assumptionVocabulary: Array<{
    id: string;
    description: string;
  }>;
  executionModeDefinitions: Record<ExecutionMode, string>;
  detailLevels: DetailLevel[];
  annexes: Annex[];
  categories: CategoryTemplate[];
}

export interface ResolvedTemplate {
  schemaVersion: 1;
  templateId: string;
  version: string;
  level: DetailLevelId;
  catalogVersion: string;
  maturity: TemplateLibrary["status"];
  owner: string;
  sha256: string;
  category: string;
  definition: string;
  examples: string[];
  counterexample: string;
  executionModes: ExecutionMode[];
  requiredSections: string[];
  emphasis: string[];
  nonGoals: string[];
  requiredDecisions: Array<{ id: string; question: string }>;
  requirements: string[];
  verifications: string[];
  annexes: Array<{ id: string; version: string; sha256: string }>;
  assumptions: string[];
  authority: string;
}

export interface LibraryValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  categoryCount: number;
  variantCount: number;
  annexCount: number;
}

export interface CompileAnswers {
  buildSpecVersion?: string;
  mission?: string;
  firstExperience?: string;
  executionMode?: ExecutionMode;
  sourceRequirements?: Array<{ text: string; sourceRefs: string[] }>;
  decisions?: Record<string, string>;
  constraints?: string[];
  scopeCutOrder?: string[];
  outOfScope?: string[];
  ownedPaths?: { contracts: string; product: string };
  factory?: { targetRepo: string; archetype: string; area: string };
  personaRouting?: {
    declaredCapabilities: string[];
    selectorValues?: Partial<Record<SelectorDimension, string>>;
    authorityOverrides?: Array<{
      taskId: string;
      roleId: string;
      authority: PersonaPhase;
      ownedPaths?: string[];
    }>;
  };
}

const ROOT = resolve(import.meta.dir, "..");
export const DEFAULT_LIBRARY_PATH = join(ROOT, "library", "template-library.json");
const CATEGORY_IDS = [
  "web-app",
  "saas",
  "mobile-app",
  "desktop-app",
  "game",
  "simulation-3d",
  "api-backend",
  "ai-application",
  "data-product",
  "automation",
  "integration",
  "developer-tool",
  "infrastructure",
  "existing-system-change",
] as const;
const LEVEL_IDS = ["starter", "standard", "factory"] as const;
const SEMVER = /^\d+\.\d+\.\d+$/;
const validateCanonicalSchema = new Ajv2020({ allErrors: true, strict: true }).compile(templateLibrarySchema);

function formatSchemaError(error: ErrorObject): string {
  const location = error.instancePath || "/";
  return `schema ${location} ${error.message ?? "is invalid"}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function assertStringList(value: unknown, label: string, errors: string[], allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => !nonEmpty(item))) {
    errors.push(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
    return [];
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) errors.push(`${label} contains duplicates`);
  return values;
}

export async function loadLibrary(path = DEFAULT_LIBRARY_PATH): Promise<TemplateLibrary> {
  if (!(await Bun.file(path).exists())) throw new Error(`Library does not exist: ${path}`);
  try {
    return JSON.parse(await Bun.file(path).text()) as TemplateLibrary;
  } catch (error) {
    throw new Error(`Invalid library JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cycleAt(annexes: Annex[]): string | null {
  const graph = new Map(annexes.map((annex) => [annex.id, annex.requires]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string | null => {
    if (visiting.has(id)) return id;
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateLibrary(library: unknown): LibraryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!library || typeof library !== "object" || Array.isArray(library)) {
    return { valid: false, errors: ["Library must be an object"], warnings, categoryCount: 0, variantCount: 0, annexCount: 0 };
  }
  if (!validateCanonicalSchema(library)) {
    return {
      valid: false,
      errors: (validateCanonicalSchema.errors ?? []).map(formatSchemaError),
      warnings,
      categoryCount: 0,
      variantCount: 0,
      annexCount: 0,
    };
  }
  const value = library as Partial<TemplateLibrary>;
  if (value.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (!nonEmpty(value.catalogVersion) || !SEMVER.test(value.catalogVersion)) errors.push("catalogVersion must be exact semantic version");
  if (!nonEmpty(value.owner)) errors.push("owner is required");
  if (!value.status || !["draft", "validated", "reviewed", "published", "deprecated"].includes(value.status)) errors.push("status is invalid");
  const resolution = value.resolutionContract;
  if (!resolution || !SEMVER.test(resolution.version) || resolution.baseTemplateCount !== 1) errors.push("resolutionContract must define exact version and one base template");
  else {
    const expectedOrder = ["category", "detail-level", "annexes-in-declared-order", "user-answers"];
    if (JSON.stringify(resolution.mergeOrder) !== JSON.stringify(expectedOrder)) errors.push("resolutionContract mergeOrder is invalid");
    if (resolution.arrayPolicy !== "append-unique") errors.push("resolutionContract arrayPolicy must be append-unique");
    if (resolution.conflictPolicy !== "fail-closed") errors.push("resolutionContract conflictPolicy must be fail-closed");
    if (resolution.hashAlgorithm !== "sha256-canonical-json" || !nonEmpty(resolution.hashInput) || !nonEmpty(resolution.hashOutput)) errors.push("resolutionContract hash contract is invalid");
    assertStringList(resolution.rules, "resolutionContract rules", errors);
  }
  const exportContract = value.exportContract;
  if (!exportContract || !SEMVER.test(exportContract.version) || exportContract.candidateOnly !== true || exportContract.requiredValidationDecision !== "PASS") errors.push("exportContract must require PASS and candidate-only artifacts");
  else {
    assertStringList(exportContract.artifactKinds, "exportContract artifactKinds", errors);
    assertStringList(exportContract.requiredLineage, "exportContract requiredLineage", errors);
    assertStringList(exportContract.ticketHeaders, "exportContract ticketHeaders", errors);
    assertStringList(exportContract.prohibitedAuthorities, "exportContract prohibitedAuthorities", errors);
    if (!nonEmpty(exportContract.failurePolicy)) errors.push("exportContract failurePolicy is required");
  }

  const assumptionVocabulary = Array.isArray(value.assumptionVocabulary) ? value.assumptionVocabulary : [];
  const assumptionIds = new Set<string>();
  if (assumptionVocabulary.length === 0) errors.push("assumptionVocabulary must define at least one assumption");
  for (const assumption of assumptionVocabulary) {
    if (!nonEmpty(assumption.id)) errors.push("assumption id is required");
    else if (assumptionIds.has(assumption.id)) errors.push(`duplicate assumption id ${assumption.id}`);
    else assumptionIds.add(assumption.id);
    if (!nonEmpty(assumption.description)) errors.push(`assumption ${String(assumption.id)} is missing description`);
  }
  const executionModeDefinitions = value.executionModeDefinitions;
  if (!executionModeDefinitions || typeof executionModeDefinitions !== "object") errors.push("executionModeDefinitions is required");
  else {
    for (const mode of ["direct", "swarm", "undecided"] as const) {
      if (!nonEmpty(executionModeDefinitions[mode])) errors.push(`executionModeDefinitions.${mode} is required`);
    }
  }

  const levels = Array.isArray(value.detailLevels) ? value.detailLevels : [];
  const levelIds = levels.map((level) => level?.id);
  if (levels.length !== 3 || LEVEL_IDS.some((id) => !levelIds.includes(id))) errors.push("detailLevels must define starter, standard, and factory exactly once");
  if (new Set(levelIds).size !== levelIds.length) errors.push("detailLevels contain duplicate ids");
  for (const level of levels) {
    if (!nonEmpty(level.description)) errors.push(`detail level ${String(level.id)} is missing description`);
    assertStringList(level.supportedExecutionModes, `detail level ${String(level.id)} supportedExecutionModes`, errors);
    assertStringList(level.requiredSections, `detail level ${String(level.id)} requiredSections`, errors);
    assertStringList(level.additionalDecisions, `detail level ${String(level.id)} additionalDecisions`, errors);
    assertStringList(level.verificationTypes, `detail level ${String(level.id)} verificationTypes`, errors);
  }

  const annexes = Array.isArray(value.annexes) ? value.annexes : [];
  const annexIds = new Set<string>();
  for (const annex of annexes) {
    if (!nonEmpty(annex.id)) errors.push("annex id is required");
    else if (annexIds.has(annex.id)) errors.push(`duplicate annex id ${annex.id}`);
    else annexIds.add(annex.id);
    if (!SEMVER.test(annex.version)) errors.push(`annex ${annex.id} version must be exact semantic version`);
    if (!nonEmpty(annex.description)) errors.push(`annex ${annex.id} is missing description`);
    assertStringList(annex.requires, `annex ${annex.id} requires`, errors, true);
    assertStringList(annex.incompatibleAnnexes, `annex ${annex.id} incompatibleAnnexes`, errors, true);
    assertStringList(annex.incompatibleAssumptions, `annex ${annex.id} incompatibleAssumptions`, errors, true);
    assertStringList(annex.decisions, `annex ${annex.id} decisions`, errors);
    assertStringList(annex.requirements, `annex ${annex.id} requirements`, errors);
    assertStringList(annex.verifications, `annex ${annex.id} verifications`, errors);
  }
  for (const annex of annexes) {
    for (const dependency of annex.requires) if (!annexIds.has(dependency)) errors.push(`annex ${annex.id} requires unknown annex ${dependency}`);
    for (const incompatible of annex.incompatibleAnnexes) if (!annexIds.has(incompatible)) errors.push(`annex ${annex.id} references unknown incompatible annex ${incompatible}`);
    for (const incompatible of annex.incompatibleAssumptions) if (!assumptionIds.has(incompatible)) errors.push(`annex ${annex.id} references unknown incompatible assumption ${incompatible}`);
  }
  const cycle = cycleAt(annexes);
  if (cycle) errors.push(`annex dependency cycle at ${cycle}`);

  const categories = Array.isArray(value.categories) ? value.categories : [];
  const categoryIds = new Set<string>();
  for (const category of categories) {
    if (!nonEmpty(category.id)) errors.push("category id is required");
    else if (categoryIds.has(category.id)) errors.push(`duplicate category id ${category.id}`);
    else categoryIds.add(category.id);
    if (!SEMVER.test(category.version)) errors.push(`category ${category.id} version must be exact semantic version`);
    for (const [field, fieldValue] of Object.entries({
      category: category.category,
      definition: category.definition,
      counterexample: category.counterexample,
    })) if (!nonEmpty(fieldValue)) errors.push(`category ${category.id} is missing ${field}`);
    for (const [field, fieldValue] of Object.entries({
      examples: category.examples,
      tags: category.tags,
      emphasis: category.emphasis,
      nonGoals: category.nonGoals,
      requiredDecisions: category.requiredDecisions,
      requirements: category.requirements,
      verifications: category.verifications,
      supportedExecutionModes: category.supportedExecutionModes,
    })) assertStringList(fieldValue, `category ${category.id} ${field}`, errors);
    assertStringList(category.recommendedAnnexes, `category ${category.id} recommendedAnnexes`, errors, true);
    for (const annex of category.recommendedAnnexes) if (!annexIds.has(annex)) errors.push(`category ${category.id} recommends unknown annex ${annex}`);
  }
  for (const id of CATEGORY_IDS) if (!categoryIds.has(id)) errors.push(`missing preserved category ${id}`);
  for (const id of categoryIds) if (!CATEGORY_IDS.includes(id as typeof CATEGORY_IDS[number])) warnings.push(`unrecognized extension category ${id}`);
  if (categories.length !== CATEGORY_IDS.length) errors.push(`expected ${CATEGORY_IDS.length} categories, found ${categories.length}`);

  const variantKeys = new Set<string>();
  for (const category of categories) {
    for (const level of levels) {
      const key = `${category.id}@${category.version}:${level.id}`;
      if (variantKeys.has(key)) errors.push(`duplicate variant ${key}`);
      variantKeys.add(key);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    categoryCount: categories.length,
    variantCount: variantKeys.size,
    annexCount: annexes.length,
  };
}

function parseTemplateRef(reference: string): { id: string; version: string } {
  const separator = reference.lastIndexOf("@");
  if (separator <= 0 || separator === reference.length - 1) throw new Error("Template reference must use exact id@version");
  const result = { id: reference.slice(0, separator), version: reference.slice(separator + 1) };
  if (!SEMVER.test(result.version)) throw new Error("Template version must be exact semantic version; floating versions are prohibited");
  return result;
}

export function resolveTemplate(
  library: TemplateLibrary,
  reference: string,
  levelId: DetailLevelId,
  annexIds: string[] = [],
  assumptions: string[] = [],
): ResolvedTemplate {
  const report = validateLibrary(library);
  if (!report.valid) throw new Error(`Library validation failed: ${report.errors.join("; ")}`);
  const { id, version } = parseTemplateRef(reference);
  const category = library.categories.find((item) => item.id === id && item.version === version);
  if (!category) throw new Error(`Unknown exact template ${reference}`);
  const level = library.detailLevels.find((item) => item.id === levelId);
  if (!level) throw new Error(`Unknown detail level ${levelId}`);
  if (new Set(annexIds).size !== annexIds.length) throw new Error("Annex list contains duplicates");
  if (new Set(assumptions).size !== assumptions.length) throw new Error("Assumption list contains duplicates");
  const knownAssumptions = new Set(library.assumptionVocabulary.map((assumption) => assumption.id));
  for (const assumption of assumptions) {
    if (!knownAssumptions.has(assumption)) throw new Error(`Unknown assumption ${assumption}`);
  }
  const selected: Annex[] = [];
  for (const annexId of annexIds) {
    const annex = library.annexes.find((item) => item.id === annexId);
    if (!annex) throw new Error(`Unknown annex ${annexId}`);
    for (const dependency of annex.requires) {
      if (!selected.some((item) => item.id === dependency)) throw new Error(`Annex ${annex.id} requires preceding annex ${dependency}`);
    }
    for (const incompatible of annex.incompatibleAssumptions) {
      if (assumptions.includes(incompatible)) throw new Error(`Annex ${annex.id} is incompatible with assumption ${incompatible}`);
    }
    for (const incompatible of annex.incompatibleAnnexes) if (selected.some((item) => item.id === incompatible)) throw new Error(`Annex ${annex.id} is incompatible with annex ${incompatible}`);
    for (const prior of selected) {
      if (prior.incompatibleAnnexes.includes(annex.id)) throw new Error(`Annex ${prior.id} is incompatible with annex ${annex.id}`);
    }
    selected.push(annex);
  }
  const executionModes = category.supportedExecutionModes.filter((mode) => level.supportedExecutionModes.includes(mode));
  if (executionModes.length === 0) throw new Error(`${reference}:${levelId} has no supported execution mode`);
  const questions = unique([...category.requiredDecisions, ...level.additionalDecisions, ...selected.flatMap((annex) => annex.decisions)]);
  const withoutHash = {
    schemaVersion: 1 as const,
    templateId: category.id,
    version: category.version,
    level: level.id,
    catalogVersion: library.catalogVersion,
    resolutionContractVersion: library.resolutionContract.version,
    maturity: library.status,
    owner: library.owner,
    category: category.category,
    definition: category.definition,
    examples: category.examples,
    counterexample: category.counterexample,
    executionModes,
    requiredSections: level.requiredSections,
    emphasis: category.emphasis,
    nonGoals: category.nonGoals,
    requiredDecisions: questions.map((question, index) => ({ id: `D-${String(index + 1).padStart(3, "0")}`, question })),
    requirements: unique([...category.requirements, ...selected.flatMap((annex) => annex.requirements)]),
    verifications: unique([...category.verifications, ...selected.flatMap((annex) => annex.verifications)]),
    annexes: selected.map((annex) => ({ id: annex.id, version: annex.version, sha256: hash(annex) })),
    assumptions,
    authority: "Resolution creates a candidate specification only; factory-ready, dispatch, merge, migration, deployment, publication, and courseware release require explicit human authority.",
  };
  return { ...withoutHash, sha256: hash(withoutHash) };
}

export function renderTemplate(template: ResolvedTemplate): string {
  const decisions = template.requiredDecisions.map((item) => `- [ ] **${item.id}** ${item.question}\n  - Answer: [required]`).join("\n");
  return `# ${template.category} - ${template.level} Template

Template: \`${template.templateId}@${template.version}\`  
Level: \`${template.level}\`  
Catalog: \`${template.catalogVersion}\`  
Template SHA-256: \`${template.sha256}\`  
Maturity: \`${template.maturity}\`

## Mission

[Describe one primary user, one observable outcome, and the first usable experience.]

## Intended Product Shape

${template.definition}

Examples: ${template.examples.join("; ")}  
Counterexample: ${template.counterexample}

## Required Decisions

${decisions}

## Capabilities and Quality Requirements

${template.requirements.map((item) => `- ${item}`).join("\n")}

## Constraints

- [Declare stack, platform, compatibility, budget, data, and environment constraints.]
- Use this exact template version and hash; do not resolve \`latest\` during execution.

## Protected Behavior

- [Name current workflows, interfaces, routes, data, and user behavior that must not change.]

## Non-Goals

${template.nonGoals.map((item) => `- ${item}`).join("\n")}

## Required Sections

${template.requiredSections.map((item) => `- ${item}`).join("\n")}

## Verification

${template.verifications.map((item) => `- ${item}`).join("\n")}

Every acceptance criterion must link to a requirement and retained verification evidence.

## Scope Cut Order

1. [First optional capability to remove]
2. [Second optional capability to remove]
3. [Protected quality that may not be cut]

## Deliverables

- Source and template provenance
- Canonical build specification
- Tests and retained evidence
- Progress and decision record

## Out of Scope

- [Explicit exclusion]

## Authority

${template.authority}
`;
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

export function selectTemplates(library: TemplateLibrary, description: string): Array<{ template: string; score: number; rationale: string; counterexample: string }> {
  if (!nonEmpty(description)) throw new Error("Description is required");
  const query = tokenize(description);
  return library.categories.map((category) => {
    const tagHits = category.tags.filter((tag) => [...tokenize(tag)].some((token) => query.has(token)));
    const exampleHits = category.examples.filter((example) => [...tokenize(example)].some((token) => query.has(token)));
    const definitionHits = [...tokenize(category.definition)].filter((token) => query.has(token));
    const score = tagHits.length * 4 + exampleHits.length * 3 + definitionHits.length;
    const rationaleParts = [
      tagHits.length ? `matched tags: ${tagHits.join(", ")}` : "",
      exampleHits.length ? `matched examples: ${exampleHits.join(", ")}` : "",
      definitionHits.length ? `matched definition terms: ${definitionHits.slice(0, 5).join(", ")}` : "",
    ].filter(Boolean);
    return {
      template: `${category.id}@${category.version}`,
      score,
      rationale: rationaleParts.join("; ") || "No strong lexical match; human classification required",
      counterexample: category.counterexample,
    };
  }).sort((left, right) => right.score - left.score || left.template.localeCompare(right.template)).slice(0, 3);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

function sourceMission(text: string): string {
  const line = text.split(/\r?\n/).map((item) => item.replace(/^#+\s*/, "").trim()).find(Boolean);
  return line ?? "Build the product described by the preserved source prompt.";
}

export function resolveTemplatePersonaMetadata(
  template: ResolvedTemplate,
  registry: PersonaAssociationRegistry,
  options: NonNullable<CompileAnswers["personaRouting"]>,
): PersonaAssociationMeta {
  const templateReference = `${template.templateId}@${template.version}`;
  const exact = registry.associations.find(
    (association) => association.templateId === template.templateId && association.templateVersion === template.version,
  );
  if (!exact) throw new Error(`No persona association for exact template ${templateReference}`);
  for (const [dimension, value] of Object.entries(options.selectorValues ?? {})) {
    const present = exact.roles.some((role) => role.activation?.allOf.some(
      (condition) => condition.dimension === dimension && condition.value === value,
    ));
    if (!present) throw new Error(`Selector ${dimension}=${value} is not present in exact association ${templateReference}`);
  }
  const resolved = resolvePersonaAssociation(
    registry,
    templateReference,
    options.declaredCapabilities,
    options.selectorValues ?? {},
  );
  return {
    templateReference,
    associationVersion: resolved.associationVersion,
    associationSha256: resolved.associationSha256,
    declaredCapabilities: [...options.declaredCapabilities],
    selectorValues: { ...(options.selectorValues ?? {}) },
    fleet: resolved.selectedRoles.map((role) => ({
      roleId: role.roleId,
      personaName: role.personaSelector.name,
      required: role.required,
      phases: [...role.phases],
      requiredScopes: [...role.requiredScopes],
      invocationCap: role.invocationCap,
    })),
    omittedRoles: resolved.omittedRoles.map((role) => ({ ...role })),
  };
}

export async function compileTemplate(
  template: ResolvedTemplate,
  sourcePath: string,
  project: string,
  owner: string,
  answers: CompileAnswers = {},
): Promise<Record<string, unknown>> {
  if (!(await Bun.file(sourcePath).exists())) throw new Error(`Source does not exist: ${sourcePath}`);
  const sourceText = await Bun.file(sourcePath).text();
  const sourceHash = await fileSha256(sourcePath);
  const sourceLineCount = sourceText.split(/\r?\n/).length;
  const executionMode = answers.executionMode ?? "undecided";
  const personaAssociation = answers.personaRouting
    ? resolveTemplatePersonaMetadata(template, await loadAssociationRegistry(), answers.personaRouting)
    : undefined;
  if (answers.executionMode !== undefined && !template.executionModes.includes(answers.executionMode)) {
    throw new Error(`Execution mode ${answers.executionMode} is not supported by ${template.templateId}@${template.version}:${template.level}; expected one of ${template.executionModes.join(", ")}`);
  }
  const sourceRequirements = answers.sourceRequirements ?? [];
  for (const [index, requirement] of sourceRequirements.entries()) {
    if (!nonEmpty(requirement.text) || !Array.isArray(requirement.sourceRefs) || requirement.sourceRefs.length === 0) {
      throw new Error(`sourceRequirements[${index}] must include text and sourceRefs`);
    }
    if (new Set(requirement.sourceRefs).size !== requirement.sourceRefs.length) {
      throw new Error(`sourceRequirements[${index}] contains duplicate sourceRefs`);
    }
    for (const ref of requirement.sourceRefs) {
      const match = ref.match(/^source:L(\d+)(?:-L(\d+))?$/);
      if (!match) throw new Error(`sourceRequirements[${index}] has invalid sourceRef ${ref}`);
      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      if (start < 1 || end < start) {
        throw new Error(`sourceRequirements[${index}] has invalid sourceRef range ${ref}`);
      }
      if (start > sourceLineCount || end > sourceLineCount) {
        throw new Error(`sourceRequirements[${index}] sourceRef exceeds ${sourceLineCount} source lines`);
      }
    }
  }
  const decisionAnswers = answers.decisions ?? {};
  const declaredDecisionIds = new Set(template.requiredDecisions.map((item) => item.id));
  for (const decisionId of Object.keys(decisionAnswers)) {
    if (!declaredDecisionIds.has(decisionId)) throw new Error(`Unknown decision ${decisionId}`);
  }
  const decisions = template.requiredDecisions.map((item) => {
    const resolution = decisionAnswers[item.id];
    return {
      id: item.id,
      question: item.question,
      options: resolution ? [resolution] : ["User-supplied decision required"],
      requiredEvidence: "User answer plus current repository or product evidence",
      owner,
      status: resolution ? "resolved" : "unresolved",
      ...(resolution ? { resolution } : {}),
    };
  });
  const requirements = [
    ...sourceRequirements.map((requirement, index) => ({
      id: `FR-${String(index + 1).padStart(3, "0")}`,
      type: "functional",
      text: requirement.text,
      origin: "source",
      sourceRefs: requirement.sourceRefs,
      verificationIds: [`V-${String(index + 1).padStart(3, "0")}`],
    })),
    ...template.requirements.map((text, index) => ({
      id: `NFR-${String(index + 1).padStart(3, "0")}`,
      type: "nonfunctional",
      text,
      origin: "proposed",
      sourceRefs: [],
      verificationIds: [`V-${String(sourceRequirements.length + index + 1).padStart(3, "0")}`],
    })),
  ];
  const verificationKinds = ["static", "integration", "contract", "human"] as const;
  const verifications = requirements.map((_, index) => ({
    id: `V-${String(index + 1).padStart(3, "0")}`,
    type: verificationKinds[Math.min(index, verificationKinds.length - 1)],
    method: template.verifications[index % template.verifications.length],
    threshold: "Declared scenario passes with retained evidence and zero critical defects",
    authority: index < 3 ? "automated" : "user",
  }));
  const acceptanceCriteria = requirements.map((requirement, index) => ({
    id: `AC-${String(index + 1).padStart(3, "0")}`,
    text: requirement.text,
    origin: "proposed",
    sourceRefs: [],
    requirementIds: [requirement.id],
    verificationIds: requirement.verificationIds,
    authority: index < 3 ? "automated" : "user",
  }));
  const ownedPaths = answers.ownedPaths ?? { contracts: "UNRESOLVED/contracts/", product: "UNRESOLVED/product/" };
  const unresolved = decisions.filter((item) => item.status === "unresolved").map((item) => ({
    id: `U-${item.id.slice(2)}`,
    question: item.question,
    blocking: true,
    owner,
  }));
  if (sourceRequirements.length === 0) unresolved.push({ id: `U-${String(unresolved.length + 1).padStart(3, "0")}`, question: "Extract and classify every load-bearing source requirement with line references.", blocking: true, owner });
  if (!answers.ownedPaths) unresolved.push({ id: `U-${String(unresolved.length + 1).padStart(3, "0")}`, question: "Confirm repository-owned paths for contracts and product work.", blocking: true, owner });
  if (executionMode === "undecided") unresolved.push({ id: `U-${String(unresolved.length + 1).padStart(3, "0")}`, question: `Select one supported execution mode: ${template.executionModes.filter((mode) => mode !== "undecided").join(", ")}.`, blocking: true, owner });
  const overrides = answers.personaRouting?.authorityOverrides ?? [];
  for (const override of overrides) {
    if (override.taskId !== "M0" && override.taskId !== "M1") throw new Error(`Unknown persona authority task ${override.taskId}`);
  }
  const assignmentsFor = (taskId: string): TaskPersonaAssignment[] => overrides
    .filter((override) => override.taskId === taskId)
    .map((override) => ({
      roleId: override.roleId,
      authority: override.authority,
      ownedPaths: [...(override.ownedPaths ?? [])],
    }));
  const spec = {
    schemaVersion: 1,
    metadata: {
      project,
      version: answers.buildSpecVersion ?? "1.0.0",
      date: new Date().toISOString().slice(0, 10),
      owner,
      releaseTier: template.level,
      executionMode,
      source: { path: sourcePath, sha256: sourceHash, label: basename(sourcePath) },
      template: {
        id: template.templateId,
        version: template.version,
        level: template.level,
        sha256: template.sha256,
        annexes: template.annexes,
      },
      ...(personaAssociation ? { personaAssociation } : {}),
    },
    mission: {
      statement: answers.mission ?? sourceMission(sourceText),
      firstExperience: answers.firstExperience ?? "The primary user completes the first declared workflow and sees a verified outcome.",
      qualities: template.emphasis.slice(0, 3),
      releaseTier: template.level,
      excludedTier: template.level === "starter" ? "multi-phase production platform" : "unbounded future scope",
    },
    ...(answers.factory ? { factory: answers.factory } : {}),
    constraints: (answers.constraints ?? [`Pin ${template.templateId}@${template.version} with template hash ${template.sha256}.`]).map((text, index) => ({
      id: `C-${String(index + 1).padStart(3, "0")}`,
      text,
      origin: "proposed",
      sourceRefs: [],
    })),
    antiGoals: template.nonGoals.map((text, index) => ({ id: `AG-${String(index + 1).padStart(3, "0")}`, text, origin: "proposed", sourceRefs: [] })),
    protectedCapabilities: [{
      id: "PC-001",
      text: "The primary user workflow and its accepted data remain operational.",
      origin: "proposed",
      sourceRefs: [],
      requirementIds: [requirements[0].id],
    }],
    scopeCutOrder: answers.scopeCutOrder ?? ["Optional secondary workflows", "Cosmetic customization", "Never cut verification of the primary workflow"],
    decisions,
    contracts: [{
      id: "SC-001",
      name: `${template.category} product contract`,
      canonicalLocation: ownedPaths.contracts,
      consumers: ["product implementation", "verification harness"],
      owner,
      invariants: ["one canonical data and state definition", "units, enums, and ownership are explicit"],
    }],
    requirements,
    verifications,
    canonicalScenarios: [{
      id: "CS-001",
      name: "Primary user journey",
      setup: "Use versioned representative inputs and the declared environment",
      action: "Complete the primary workflow from start to observable outcome",
      qualities: template.emphasis.slice(0, 3),
      evidence: "Assertions plus user-visible or machine-readable retained evidence",
    }],
    acceptanceCriteria,
    milestones: [
      {
        id: "M0",
        name: "Contracts and verification harness",
        dependencies: [],
        ownedPaths: [ownedPaths.contracts],
        exitCriteria: [acceptanceCriteria[0].id],
        approval: "automated",
        owner,
        ...(assignmentsFor("M0").length > 0 ? { personaAssignments: assignmentsFor("M0") } : {}),
      },
      {
        id: "M1",
        name: "Primary product journey",
        dependencies: ["M0"],
        ownedPaths: [ownedPaths.product],
        exitCriteria: acceptanceCriteria.slice(1).map((item) => item.id),
        approval: "user",
        owner,
        ...(assignmentsFor("M1").length > 0 ? { personaAssignments: assignmentsFor("M1") } : {}),
      },
    ],
    humanCriteria: [{ id: "HC-001", question: "Does the primary workflow satisfy the intended user outcome without violating protected behavior?", scenarioIds: ["CS-001"], approver: owner }],
    deliverables: ["Canonical build specification", "Implementation", "Tests", "Evidence matrix", "Decision and provenance record"],
    outOfScope: answers.outOfScope ?? template.nonGoals,
    unresolved,
  };
  const report = validateSpec(spec);
  if (!report.valid) throw new Error(`Compiled specification is invalid: ${report.errors.join("; ")}`);
  return spec;
}

export function buildIndex(library: TemplateLibrary): Record<string, unknown> {
  const entries = library.categories.flatMap((category) => LEVEL_IDS.map((level) => {
    const template = resolveTemplate(library, `${category.id}@${category.version}`, level);
    return {
      templateId: template.templateId,
      version: template.version,
      level: template.level,
      sha256: template.sha256,
      maturity: template.maturity,
      category: template.category,
      supportedExecutionModes: template.executionModes,
    };
  }));
  return {
    schemaVersion: 1,
    catalogVersion: library.catalogVersion,
    status: library.status,
    resolutionContract: library.resolutionContract,
    exportContract: library.exportContract,
    assumptionVocabulary: library.assumptionVocabulary,
    executionModeDefinitions: library.executionModeDefinitions,
    entries,
    annexes: library.annexes.map((annex) => ({ id: annex.id, version: annex.version, sha256: hash(annex), requires: annex.requires, incompatibleAnnexes: annex.incompatibleAnnexes, incompatibleAssumptions: annex.incompatibleAssumptions })),
    authority: "Discovery does not grant factory-ready, dispatch, merge, deployment, publication, or courseware-release authority.",
  };
}

async function write(path: string, value: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, value);
}

function usage(exitCode = 1): never {
  process.stderr.write(`software-template-library

Commands:
  validate [--library FILE]
  list [--library FILE]
  select --description TEXT [--library FILE]
  resolve --template ID@VERSION --level LEVEL [--annexes CSV] [--assumptions CSV] --output FILE
  render --template ID@VERSION --level LEVEL [--annexes CSV] [--assumptions CSV] --output FILE
  build-all --output-dir DIR
  index --output FILE
  compile --template ID@VERSION --level LEVEL --source FILE --project NAME --owner NAME --output FILE [--annexes CSV] [--answers FILE]
  export-ticket --spec FILE --output FILE
  export-seed --spec FILE --output FILE
`);
  process.exit(exitCode);
}

function parseArgs(args: string[]): { command: string; flags: Map<string, string | true> } {
  const command = args[0];
  if (command === "--help" || command === "-h") usage(0);
  if (!command) usage();
  const flags = new Map<string, string | true>();
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) flags.set(token, true);
    else {
      flags.set(token, next);
      index++;
    }
  }
  return { command, flags };
}

function flag(flags: Map<string, string | true>, name: string, required = true): string | undefined {
  const value = flags.get(name);
  if (typeof value === "string") return value;
  if (required) throw new Error(`Missing ${name}`);
  return undefined;
}

async function readJson<T>(path: string): Promise<T> {
  if (!(await Bun.file(path).exists())) throw new Error(`File does not exist: ${path}`);
  return JSON.parse(await Bun.file(path).text()) as T;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  const libraryPath = resolve(flag(flags, "--library", false) ?? DEFAULT_LIBRARY_PATH);
  const library = await loadLibrary(libraryPath);
  if (command === "validate") {
    const report = validateLibrary(library);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.valid ? 0 : 1;
    return;
  }
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(buildIndex(library), null, 2)}\n`);
    return;
  }
  if (command === "select") {
    process.stdout.write(`${JSON.stringify({ decision: "HUMAN_SELECTION_REQUIRED", recommendations: selectTemplates(library, flag(flags, "--description")!) }, null, 2)}\n`);
    return;
  }
  if (command === "index") {
    await write(resolve(flag(flags, "--output")!), `${JSON.stringify(buildIndex(library), null, 2)}\n`);
    return;
  }
  if (command === "build-all") {
    const outputDir = resolve(flag(flags, "--output-dir")!);
    for (const category of library.categories) {
      for (const level of LEVEL_IDS) {
        const template = resolveTemplate(library, `${category.id}@${category.version}`, level);
        await write(join(outputDir, category.id, `${level}.prompt.md`), renderTemplate(template));
        await write(join(outputDir, category.id, `${level}.manifest.json`), `${JSON.stringify(template, null, 2)}\n`);
      }
    }
    process.stdout.write(`generated ${library.categories.length * LEVEL_IDS.length} template variants\n`);
    return;
  }
  if (command === "resolve" || command === "render" || command === "compile") {
    const template = resolveTemplate(
      library,
      flag(flags, "--template")!,
      flag(flags, "--level")! as DetailLevelId,
      (flag(flags, "--annexes", false) ?? "").split(",").filter(Boolean),
      (flag(flags, "--assumptions", false) ?? "").split(",").filter(Boolean),
    );
    const output = resolve(flag(flags, "--output")!);
    if (command === "resolve") await write(output, `${JSON.stringify(template, null, 2)}\n`);
    else if (command === "render") await write(output, renderTemplate(template));
    else {
      const answersPath = flag(flags, "--answers", false);
      const answers = answersPath ? await readJson<CompileAnswers>(resolve(answersPath)) : {};
      const spec = await compileTemplate(
        template,
        resolve(flag(flags, "--source")!),
        flag(flags, "--project")!,
        flag(flags, "--owner")!,
        answers,
      );
      await write(output, `${JSON.stringify(spec, null, 2)}\n`);
      const report = validateSpec(spec);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.decision === "PASS" ? 0 : report.decision === "HOLD" ? 2 : 1;
    }
    return;
  }
  if (command === "export-ticket" || command === "export-seed") {
    const spec = await readJson<Record<string, unknown>>(resolve(flag(flags, "--spec")!));
    const report = validateSpec(spec);
    const artifact = command === "export-ticket" ? renderFactoryTicket(spec as never, report) : renderFactorySeed(spec as never, report);
    await write(resolve(flag(flags, "--output")!), artifact);
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
