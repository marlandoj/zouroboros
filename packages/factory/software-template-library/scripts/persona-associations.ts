#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import personaAssociationsSchema from "../schema/persona-associations.schema.json";

export type PersonaPhase = "advise" | "implement" | "review";
export type SelectorDimension = "engine" | "platform";

export interface VocabularyEntry {
  id: string;
  description: string;
}

export interface ScopeEntry extends VocabularyEntry {
  phases: PersonaPhase[];
}

export interface SelectorVocabularyEntry {
  dimension: SelectorDimension;
  values: string[];
}

export interface CapabilitySelector {
  allOf: string[];
  anyOf: string[];
  noneOf: string[];
}

export interface SelectorCondition {
  dimension: SelectorDimension;
  operator: "equals";
  value: string;
  capability: string;
}

export interface RoleActivation {
  allOf: SelectorCondition[];
  requiresRoles: string[];
}

export interface PersonaAssociationRole {
  roleId: string;
  personaSelector: {
    type: "exact-name";
    name: string;
  };
  required: boolean;
  phases: PersonaPhase[];
  capabilitySelector: CapabilitySelector;
  requiredScopes: string[];
  invocationCap: number;
  activation: RoleActivation | null;
}

export interface TemplatePersonaAssociation {
  templateId: string;
  templateVersion: string;
  category: string;
  roles: PersonaAssociationRole[];
}

export interface PersonaAssociationRegistry {
  schemaVersion: 1;
  associationVersion: string;
  catalogVersion: string;
  status: "draft" | "validated" | "reviewed" | "published" | "deprecated";
  owner: string;
  hashContract: {
    version: string;
    algorithm: "sha256-canonical-json";
    registryInput: string;
    associationInput: string;
    output: "lowercase-hex-64";
  };
  dispatchContract: {
    version: string;
    defaultAuthority: "advise-review-only";
    implementationAuthority: string;
    identityResolution: string;
    identityEvidence: string;
    uuidPolicy: string;
    routingIndependence: string;
    requiredFailurePolicy: string;
    optionalFailurePolicy: string;
    outputTrust: string;
    modes: {
      off: string;
      shadow: string;
      enforce: string;
    };
  };
  capabilityVocabulary: VocabularyEntry[];
  scopeVocabulary: ScopeEntry[];
  selectorVocabulary: SelectorVocabularyEntry[];
  associations: TemplatePersonaAssociation[];
}

export interface TemplateIdentity {
  id: string;
  version: string;
  category: string;
}

export interface AssociationValidation {
  valid: boolean;
  errors: string[];
  associationCount: number;
  roleCount: number;
  requiredRoleCount: number;
}

export interface PersonaAssociationIndexEntry {
  key: string;
  templateId: string;
  templateVersion: string;
  category: string;
  sha256: string;
  roleCount: number;
  requiredRoleCount: number;
}

export interface PersonaAssociationIndex {
  schemaVersion: 1;
  associationVersion: string;
  catalogVersion: string;
  registrySha256: string;
  hashAlgorithm: "sha256-canonical-json";
  entries: PersonaAssociationIndexEntry[];
}

export interface OmittedAssociationRole {
  roleId: string;
  reason: "capability-mismatch" | "selector-mismatch" | "unmet-role-dependency";
}

export interface ResolvedPersonaAssociation {
  key: string;
  associationVersion: string;
  associationSha256: string;
  selectedRoles: PersonaAssociationRole[];
  omittedRoles: OmittedAssociationRole[];
}

interface TemplateLibraryShape {
  catalogVersion: string;
  categories: TemplateIdentity[];
}

const ROOT = resolve(import.meta.dir, "..");
export const DEFAULT_ASSOCIATIONS_PATH = join(ROOT, "library", "persona-associations.json");
export const DEFAULT_ASSOCIATION_INDEX_PATH = join(ROOT, "library", "persona-association-index.json");
export const DEFAULT_TEMPLATE_LIBRARY_PATH = join(ROOT, "library", "template-library.json");
const SEMVER = /^\d+\.\d+\.\d+$/;
const PHASES = new Set<PersonaPhase>(["advise", "implement", "review"]);
const EXACT_NAME = /^(?!.*[?*\[\]])\S(?:.*\S)?$/;
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(personaAssociationsSchema);

function schemaError(error: ErrorObject): string {
  return `schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("Canonical JSON does not permit undefined values");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`Canonical JSON cannot encode ${typeof value}`);
  return encoded;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashRegistry(registry: PersonaAssociationRegistry): string {
  return sha256(registry);
}

export function hashAssociation(
  registry: Pick<PersonaAssociationRegistry, "associationVersion" | "catalogVersion">,
  association: TemplatePersonaAssociation,
): string {
  return sha256({
    associationVersion: registry.associationVersion,
    catalogVersion: registry.catalogVersion,
    association,
  });
}

export async function loadAssociationRegistry(path = DEFAULT_ASSOCIATIONS_PATH): Promise<PersonaAssociationRegistry> {
  if (!(await Bun.file(path).exists())) throw new Error(`Persona association registry does not exist: ${path}`);
  try {
    return JSON.parse(await Bun.file(path).text()) as PersonaAssociationRegistry;
  } catch (error) {
    throw new Error(`Invalid persona association JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadTemplateIdentities(path = DEFAULT_TEMPLATE_LIBRARY_PATH): Promise<{
  catalogVersion: string;
  templates: TemplateIdentity[];
}> {
  const library = JSON.parse(await Bun.file(path).text()) as TemplateLibraryShape;
  return {
    catalogVersion: library.catalogVersion,
    templates: library.categories.map(({ id, version, category }) => ({ id, version, category })),
  };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function detectRoleCycle(roles: PersonaAssociationRole[]): string | null {
  const graph = new Map(roles.map((role) => [role.roleId, role.activation?.requiresRoles ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (roleId: string): string | null => {
    if (visiting.has(roleId)) return roleId;
    if (visited.has(roleId)) return null;
    visiting.add(roleId);
    for (const dependency of graph.get(roleId) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    visiting.delete(roleId);
    visited.add(roleId);
    return null;
  };
  for (const roleId of graph.keys()) {
    const cycle = visit(roleId);
    if (cycle) return cycle;
  }
  return null;
}

function validateRole(
  role: PersonaAssociationRole,
  associationKey: string,
  roleIds: Set<string>,
  capabilities: Set<string>,
  scopes: Map<string, ScopeEntry>,
  selectors: Map<string, Set<string>>,
  errors: string[],
): void {
  const label = `${associationKey} role ${role.roleId}`;
  if (!EXACT_NAME.test(role.personaSelector.name)) {
    errors.push(`${label} persona selector must be one exact, trimmed name without wildcard syntax`);
  }
  for (const phase of role.phases) {
    if (!PHASES.has(phase)) errors.push(`${label} references unknown phase ${phase}`);
  }
  for (const group of ["allOf", "anyOf", "noneOf"] as const) {
    for (const capability of role.capabilitySelector[group]) {
      if (!capabilities.has(capability)) errors.push(`${label} references unknown capability ${capability}`);
    }
  }
  const positiveCapabilities = new Set([
    ...role.capabilitySelector.allOf,
    ...role.capabilitySelector.anyOf,
  ]);
  for (const capability of role.capabilitySelector.noneOf) {
    if (positiveCapabilities.has(capability)) {
      errors.push(`${label} has contradictory capability selector for ${capability}`);
    }
  }
  for (const scope of role.requiredScopes) {
    const definition = scopes.get(scope);
    if (!definition) {
      errors.push(`${label} references unknown required scope ${scope}`);
    } else if (!definition.phases.some((phase) => role.phases.includes(phase))) {
      errors.push(`${label} scope ${scope} is not valid for any permitted role phase`);
    }
  }
  if ((role.phases.includes("advise") || role.phases.includes("review")) && !role.requiredScopes.includes("files:read")) {
    errors.push(`${label} advise/review scope contract requires files:read`);
  }
  if (
    role.phases.includes("implement") &&
    (!role.requiredScopes.includes("files:read") || !role.requiredScopes.includes("files:write"))
  ) {
    errors.push(`${label} implement scope contract requires files:read and files:write`);
  }
  if (!role.activation) return;
  const equalityByDimension = new Map<string, string>();
  for (const condition of role.activation.allOf) {
    if (!capabilities.has(condition.capability)) {
      errors.push(`${label} activation references unknown capability ${condition.capability}`);
    }
    if (!role.capabilitySelector.allOf.includes(condition.capability)) {
      errors.push(`${label} activation capability ${condition.capability} must also be required by capabilitySelector.allOf`);
    }
    const values = selectors.get(condition.dimension);
    if (!values || !values.has(condition.value)) {
      errors.push(`${label} activation references unknown ${condition.dimension} selector value ${condition.value}`);
    }
    const existing = equalityByDimension.get(condition.dimension);
    if (existing && existing !== condition.value) {
      errors.push(`${label} has contradictory ${condition.dimension} equality conditions ${existing} and ${condition.value}`);
    }
    equalityByDimension.set(condition.dimension, condition.value);
  }
  for (const dependency of role.activation.requiresRoles) {
    if (!roleIds.has(dependency)) errors.push(`${label} requires unknown role ${dependency}`);
    if (dependency === role.roleId) errors.push(`${label} cannot require itself`);
  }
}

export function validateAssociationRegistry(
  registry: PersonaAssociationRegistry,
  templates?: TemplateIdentity[],
  expectedCatalogVersion?: string,
): AssociationValidation {
  const errors: string[] = [];
  if (!validateSchema(registry)) errors.push(...(validateSchema.errors ?? []).map(schemaError));
  if (!SEMVER.test(registry.associationVersion)) errors.push("associationVersion must be an exact semantic version");
  if (!SEMVER.test(registry.catalogVersion)) errors.push("catalogVersion must be an exact semantic version");
  if (expectedCatalogVersion && registry.catalogVersion !== expectedCatalogVersion) {
    errors.push(`catalogVersion ${registry.catalogVersion} does not match template catalog ${expectedCatalogVersion}`);
  }

  const capabilityIds = registry.capabilityVocabulary.map((entry) => entry.id);
  for (const duplicate of duplicateValues(capabilityIds)) errors.push(`duplicate capability vocabulary id ${duplicate}`);
  const scopeIds = registry.scopeVocabulary.map((entry) => entry.id);
  for (const duplicate of duplicateValues(scopeIds)) errors.push(`duplicate scope vocabulary id ${duplicate}`);
  const selectorDimensions = registry.selectorVocabulary.map((entry) => entry.dimension);
  for (const duplicate of duplicateValues(selectorDimensions)) errors.push(`duplicate selector dimension ${duplicate}`);
  for (const entry of registry.selectorVocabulary) {
    for (const duplicate of duplicateValues(entry.values)) {
      errors.push(`selector dimension ${entry.dimension} contains duplicate value ${duplicate}`);
    }
  }

  const associationKeys = registry.associations.map(
    (association) => `${association.templateId}@${association.templateVersion}`,
  );
  for (const duplicate of duplicateValues(associationKeys)) errors.push(`duplicate association ${duplicate}`);
  const templateMap = templates
    ? new Map(templates.map((template) => [`${template.id}@${template.version}`, template]))
    : null;
  if (templateMap) {
    for (const key of templateMap.keys()) {
      if (!associationKeys.includes(key)) errors.push(`missing association for published template ${key}`);
    }
    for (const association of registry.associations) {
      const key = `${association.templateId}@${association.templateVersion}`;
      const template = templateMap.get(key);
      if (!template) errors.push(`association ${key} does not match an exact published template`);
      else if (template.category !== association.category) {
        errors.push(`association ${key} category ${association.category} does not match ${template.category}`);
      }
    }
  }

  const capabilities = new Set(capabilityIds);
  const scopes = new Map(registry.scopeVocabulary.map((scope) => [scope.id, scope]));
  const selectors = new Map(
    registry.selectorVocabulary.map((entry) => [entry.dimension, new Set(entry.values)]),
  );
  for (const association of registry.associations) {
    const key = `${association.templateId}@${association.templateVersion}`;
    if (!SEMVER.test(association.templateVersion)) errors.push(`${key} must use an exact semantic template version`);
    const roleIds = association.roles.map((role) => role.roleId);
    for (const duplicate of duplicateValues(roleIds)) errors.push(`${key} contains duplicate role id ${duplicate}`);
    const personaNames = association.roles.map((role) => role.personaSelector.name);
    for (const duplicate of duplicateValues(personaNames)) {
      errors.push(`${key} contains duplicate exact persona selector ${duplicate}`);
    }
    const roleIdSet = new Set(roleIds);
    for (const role of association.roles) {
      validateRole(role, key, roleIdSet, capabilities, scopes, selectors, errors);
    }
    const cycle = detectRoleCycle(association.roles);
    if (cycle) errors.push(`${key} contains cyclic role activation conditions at ${cycle}`);
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    associationCount: registry.associations.length,
    roleCount: registry.associations.reduce((sum, association) => sum + association.roles.length, 0),
    requiredRoleCount: registry.associations.reduce(
      (sum, association) => sum + association.roles.filter((role) => role.required).length,
      0,
    ),
  };
}

export async function validateCanonicalAssociationRegistry(
  path = DEFAULT_ASSOCIATIONS_PATH,
  templatePath = DEFAULT_TEMPLATE_LIBRARY_PATH,
): Promise<AssociationValidation> {
  const [registry, catalog] = await Promise.all([
    loadAssociationRegistry(path),
    loadTemplateIdentities(templatePath),
  ]);
  return validateAssociationRegistry(registry, catalog.templates, catalog.catalogVersion);
}

export function buildAssociationIndex(registry: PersonaAssociationRegistry): PersonaAssociationIndex {
  return {
    schemaVersion: 1,
    associationVersion: registry.associationVersion,
    catalogVersion: registry.catalogVersion,
    registrySha256: hashRegistry(registry),
    hashAlgorithm: "sha256-canonical-json",
    entries: registry.associations.map((association) => ({
      key: `${association.templateId}@${association.templateVersion}`,
      templateId: association.templateId,
      templateVersion: association.templateVersion,
      category: association.category,
      sha256: hashAssociation(registry, association),
      roleCount: association.roles.length,
      requiredRoleCount: association.roles.filter((role) => role.required).length,
    })),
  };
}

export async function writeAssociationIndex(
  registry: PersonaAssociationRegistry,
  path = DEFAULT_ASSOCIATION_INDEX_PATH,
): Promise<void> {
  await Bun.write(path, `${JSON.stringify(buildAssociationIndex(registry), null, 2)}\n`);
}

export function parseExactTemplateReference(reference: string): { templateId: string; templateVersion: string } {
  const match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+)$/.exec(reference);
  if (!match) throw new Error(`Template reference must use exact id@semantic-version syntax: ${reference}`);
  return { templateId: match[1], templateVersion: match[2] };
}

function capabilityMatches(selector: CapabilitySelector, declared: Set<string>): boolean {
  return (
    selector.allOf.every((capability) => declared.has(capability)) &&
    (selector.anyOf.length === 0 || selector.anyOf.some((capability) => declared.has(capability))) &&
    selector.noneOf.every((capability) => !declared.has(capability))
  );
}

export function resolvePersonaAssociation(
  registry: PersonaAssociationRegistry,
  templateReference: string,
  declaredCapabilities: string[],
  selectorValues: Partial<Record<SelectorDimension, string>> = {},
): ResolvedPersonaAssociation {
  const report = validateAssociationRegistry(registry);
  if (!report.valid) throw new Error(`Invalid persona association registry: ${report.errors.join("; ")}`);
  const { templateId, templateVersion } = parseExactTemplateReference(templateReference);
  const association = registry.associations.find(
    (candidate) => candidate.templateId === templateId && candidate.templateVersion === templateVersion,
  );
  if (!association) throw new Error(`No persona association for exact template ${templateReference}`);
  const knownCapabilities = new Set(registry.capabilityVocabulary.map((entry) => entry.id));
  for (const capability of declaredCapabilities) {
    if (!knownCapabilities.has(capability)) throw new Error(`Unknown declared capability ${capability}`);
  }
  if (new Set(declaredCapabilities).size !== declaredCapabilities.length) {
    throw new Error("Declared capabilities contain duplicates");
  }
  const selectorVocabulary = new Map(
    registry.selectorVocabulary.map((entry) => [entry.dimension, new Set(entry.values)]),
  );
  for (const [dimension, value] of Object.entries(selectorValues)) {
    const values = selectorVocabulary.get(dimension as SelectorDimension);
    if (!values || !value || !values.has(value)) throw new Error(`Unknown ${dimension} selector value ${value}`);
  }

  const declared = new Set(declaredCapabilities);
  const baseEligible = new Map<string, "eligible" | "capability-mismatch" | "selector-mismatch">();
  for (const role of association.roles) {
    if (!capabilityMatches(role.capabilitySelector, declared)) {
      baseEligible.set(role.roleId, "capability-mismatch");
      continue;
    }
    if (
      role.activation &&
      !role.activation.allOf.every(
        (condition) =>
          declared.has(condition.capability) && selectorValues[condition.dimension] === condition.value,
      )
    ) {
      baseEligible.set(role.roleId, "selector-mismatch");
      continue;
    }
    baseEligible.set(role.roleId, "eligible");
  }

  const selectedIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const role of association.roles) {
      if (selectedIds.has(role.roleId) || baseEligible.get(role.roleId) !== "eligible") continue;
      const dependencies = role.activation?.requiresRoles ?? [];
      if (dependencies.every((dependency) => selectedIds.has(dependency))) {
        selectedIds.add(role.roleId);
        changed = true;
      }
    }
  }

  return {
    key: templateReference,
    associationVersion: registry.associationVersion,
    associationSha256: hashAssociation(registry, association),
    selectedRoles: association.roles.filter((role) => selectedIds.has(role.roleId)),
    omittedRoles: association.roles
      .filter((role) => !selectedIds.has(role.roleId))
      .map((role) => ({
        roleId: role.roleId,
        reason:
          baseEligible.get(role.roleId) === "eligible"
            ? "unmet-role-dependency"
            : (baseEligible.get(role.roleId) as "capability-mismatch" | "selector-mismatch"),
      })),
  };
}

async function main(): Promise<void> {
  const [command = "validate", ...args] = Bun.argv.slice(2);
  if (command === "validate") {
    const report = await validateCanonicalAssociationRegistry(args[0] ?? DEFAULT_ASSOCIATIONS_PATH);
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid) process.exitCode = 1;
    return;
  }
  if (command === "index") {
    const registry = await loadAssociationRegistry(args[0] ?? DEFAULT_ASSOCIATIONS_PATH);
    const report = await validateCanonicalAssociationRegistry(args[0] ?? DEFAULT_ASSOCIATIONS_PATH);
    if (!report.valid) throw new Error(report.errors.join("; "));
    const output = args[1] ?? DEFAULT_ASSOCIATION_INDEX_PATH;
    await writeAssociationIndex(registry, output);
    console.log(JSON.stringify({ valid: true, output, registrySha256: hashRegistry(registry) }, null, 2));
    return;
  }
  if (command === "resolve") {
    const registry = await loadAssociationRegistry(args[1] ?? DEFAULT_ASSOCIATIONS_PATH);
    const capabilities = args[2] ? args[2].split(",").filter(Boolean) : [];
    const selectors = args[3] ? (JSON.parse(args[3]) as Partial<Record<SelectorDimension, string>>) : {};
    console.log(JSON.stringify(resolvePersonaAssociation(registry, args[0] ?? "", capabilities, selectors), null, 2));
    return;
  }
  throw new Error(`Unknown command ${command}. Expected validate, index, or resolve.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
