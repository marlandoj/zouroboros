#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const FACTORY_RELATIVE_DIR = join("Projects", "zouroboros-software-factory");
const TEMPLATE_LIBRARY_RELATIVE_DIR = join("Projects", "software-template-library");
const STATE_MARKER = ".factory-state-root.json";
const COPY_DIRECTORIES = ["scripts", "contracts", "fixtures", "game-gauntlet", "scenarios"] as const;
const COPY_FILES = ["package.json", "README.md", "MVP_PATH.md", "OPERATORS_MANUAL.md", "tsconfig.json", "LICENSE"] as const;
const TEMPLATE_LIBRARY_SOURCE_DIR = "software-template-library";
const TEMPLATE_LIBRARY_RUNTIME_DEPENDENCIES = ["ajv", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"] as const;
const EXPECTED_TEMPLATE_LIBRARY = {
  schema_version: 1,
  catalog_version: "1.0.0",
  tooling_version: "1.0.1",
  catalog_sha256: "fd5485d1e87a9064170691c19d4c7f30354aaade25a86fea763ac3f26c2059d3",
  manifest_index_sha256: "6c8dc4d3fc87f30aa08b827698e139c8369a765cd6a41b1d0512cc572f86687d",
  persona_associations_sha256: "e709af45566c4b0248ca77e8ca9aa692133bd5636a85e95e9c0254e9301173f4",
  persona_association_index_sha256: "45922df5582e36fc8ecd6c1d7571130b4857aae1ec43057dc3066e762b939bfc",
  maturity: "published",
  execution_authority: false,
} as const;
const TEMPLATE_LIBRARY_HASHED_FILES = {
  catalog_sha256: "library/template-library.json",
  manifest_index_sha256: "library/manifest-index.json",
  persona_associations_sha256: "library/persona-associations.json",
  persona_association_index_sha256: "library/persona-association-index.json",
} as const;
const REQUIRED_TEMPLATE_LIBRARY_FILES = [
  "package.json",
  "README.md",
  "distribution.json",
  "library/template-library.json",
  "library/manifest-index.json",
  "library/persona-associations.json",
  "library/persona-association-index.json",
  "schema/template-library.schema.json",
  "schema/persona-associations.schema.json",
  "scripts/template-library.ts",
  "scripts/persona-associations.ts",
  "templates/TEMPLATE_CATALOG.md",
  "templates/generated/web-app/standard.manifest.json",
] as const;
const FORBIDDEN_TEMPLATE_LIBRARY_PATHS = [
  "evaluations",
  "PROJECT.md",
  "BACKLOG.md",
  "PROGRESS.md",
  "scripts/review-library.ts",
  "scripts/sync-linear.ts",
  "scripts/set-linear-state.ts",
] as const;
const REQUIRED_FACTORY_FILES = [
  "package.json",
  "scripts/factory-package-cli.ts",
  "scripts/factory-mvp.ts",
  "scripts/swarm-decision-gate.ts",
  "scripts/dispatcher.ts",
  "scripts/prespec-runner.ts",
  "scripts/swarm-exec.ts",
  "scripts/runtime-config.ts",
  "game-gauntlet/scripts/game-seed-preflight.ts",
  "contracts/factory-runtime-state-v1.md",
  "config/factory-state-owners-v1.json",
  "config/runtime-flags.json",
] as const;

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

export interface InstallOptions {
  root: string;
  factoryDir?: string;
  stateDir?: string;
  force?: boolean;
  resetConfig?: boolean;
  sourceRoot?: string;
}

export interface InstallResult {
  root: string;
  factory_dir: string;
  template_library_dir: string;
  state_dir: string;
  package_version: string;
  template_library_catalog_version: string;
  template_library_tooling_version: string;
  config: "created" | "preserved" | "reset";
  copied_files: number;
  scheduler_configured: false;
}

export interface DoctorCheck {
  status: "PASS" | "WARN" | "FAIL";
  label: string;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  root: string;
  factory_dir: string;
  template_library_dir: string;
  checks: DoctorCheck[];
}

interface TemplateLibraryDistribution {
  schema_version: number;
  catalog_version: string;
  tooling_version: string;
  catalog_sha256: string;
  manifest_index_sha256: string;
  persona_associations_sha256: string;
  persona_association_index_sha256: string;
  maturity: string;
  execution_authority: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return typeof value === "string" ? value : undefined;
}

function canonicalPath(path: string, label: string): string {
  if (!path || path.includes("\0")) throw new Error(`${label} must be a non-empty path`);
  const canonical = resolve(path);
  if (canonical === sep) throw new Error(`${label} must not be the filesystem root`);
  return canonical;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) throw new Error(`path escapes destination: ${candidate}`);
}

function readPackageVersion(sourceRoot = PACKAGE_ROOT): string {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version) throw new Error("factory package version is missing");
  return manifest.version;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readTemplateLibraryDistribution(libraryDir: string): TemplateLibraryDistribution {
  return JSON.parse(readFileSync(join(libraryDir, "distribution.json"), "utf8")) as TemplateLibraryDistribution;
}

function templateLibraryBoundaryChecks(libraryDir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const file of REQUIRED_TEMPLATE_LIBRARY_FILES) {
    const present = existsSync(join(libraryDir, file));
    checks.push({ status: present ? "PASS" : "FAIL", label: `template library ${file}`, detail: present ? "present" : "missing" });
  }
  for (const path of FORBIDDEN_TEMPLATE_LIBRARY_PATHS) {
    const excluded = !existsSync(join(libraryDir, path));
    checks.push({ status: excluded ? "PASS" : "FAIL", label: `template library exclude ${path}`, detail: excluded ? "excluded" : "unsafe distribution content present" });
  }
  if (checks.some((check) => check.status === "FAIL")) return checks;

  let distribution: TemplateLibraryDistribution;
  try {
    distribution = readTemplateLibraryDistribution(libraryDir);
  } catch (error) {
    checks.push({ status: "FAIL", label: "template library distribution", detail: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  for (const [key, expected] of Object.entries(EXPECTED_TEMPLATE_LIBRARY)) {
    const actual = distribution[key as keyof TemplateLibraryDistribution];
    checks.push({
      status: actual === expected ? "PASS" : "FAIL",
      label: `template library ${key}`,
      detail: actual === expected ? String(actual) : `expected ${String(expected)}, found ${String(actual)}`,
    });
  }
  for (const [hashKey, relativePath] of Object.entries(TEMPLATE_LIBRARY_HASHED_FILES)) {
    const expected = EXPECTED_TEMPLATE_LIBRARY[hashKey as keyof typeof EXPECTED_TEMPLATE_LIBRARY];
    const actual = sha256File(join(libraryDir, relativePath));
    checks.push({
      status: actual === expected ? "PASS" : "FAIL",
      label: `template library hash ${relativePath}`,
      detail: actual === expected ? actual : `expected ${String(expected)}, found ${actual}`,
    });
  }
  return checks;
}

function writeAtomic(path: string, content: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content);
  if (mode !== undefined) chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function copyTree(sourceRoot: string, source: string, destinationRoot: string, destination: string): number {
  assertContained(sourceRoot, source);
  assertContained(destinationRoot, destination);
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`refusing to package symlink: ${source}`);
  if (sourceStat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    let count = 0;
    for (const entry of readdirSync(source).sort()) {
      count += copyTree(sourceRoot, join(source, entry), destinationRoot, join(destination, entry));
    }
    return count;
  }
  if (!sourceStat.isFile()) throw new Error(`unsupported package entry: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  copyFileSync(source, temporary);
  chmodSync(temporary, sourceStat.mode & 0o777);
  renameSync(temporary, destination);
  return 1;
}

function copyTemplateLibraryRuntimeDependencies(sourceRoot: string, destinationRoot: string, templateLibraryDir: string): number {
  const requireFromFactory = createRequire(join(sourceRoot, "package.json"));
  const ajvManifest = realpathSync(requireFromFactory.resolve("ajv/package.json"));
  const requireFromAjv = createRequire(ajvManifest);
  let copiedFiles = 0;
  for (const dependency of TEMPLATE_LIBRARY_RUNTIME_DEPENDENCIES) {
    const manifest = dependency === "ajv"
      ? ajvManifest
      : realpathSync(requireFromAjv.resolve(`${dependency}/package.json`));
    const dependencyRoot = dirname(manifest);
    copiedFiles += copyTree(
      dependencyRoot,
      dependencyRoot,
      destinationRoot,
      join(templateLibraryDir, "node_modules", dependency),
    );
  }
  return copiedFiles;
}

function initializeStateRoot(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const stateStat = lstatSync(stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error("factory state root must be a real directory");
  if (realpathSync(stateDir) !== stateDir) throw new Error("factory state root must be canonical");
  const markerPath = join(stateDir, STATE_MARKER);
  if (existsSync(markerPath)) return;
  if (readdirSync(stateDir).length > 0) throw new Error("refusing to claim a non-empty unmarked factory state directory");
  writeAtomic(markerPath, `${JSON.stringify({
    namespace: "zouroboros-software-factory",
    schema_version: 1,
    root_id: randomUUID(),
    canonical_path: stateDir,
    generation: 0,
    device: stateStat.dev,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, 0o600);
}

function safeRuntimeConfig(sourceRoot: string, root: string, stateDir: string): string {
  const template = readFileSync(join(sourceRoot, "templates", "config", "runtime-flags.json"), "utf8");
  const materialized = template
    .replaceAll("/__FACTORY_STATE_DIR__", stateDir)
    .replaceAll("/__ZOUROBOROS_ROOT__", root);
  const parsed = JSON.parse(materialized) as { updated_at: string; flags: Record<string, string> };
  parsed.updated_at = new Date().toISOString();
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertZouroborosRoot(root: string): void {
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "packages"))) {
    throw new Error(`${root} is not a Zouroboros checkout; expected package.json and packages/`);
  }
}

export function installFactory(options: InstallOptions): InstallResult {
  const sourceRoot = canonicalPath(options.sourceRoot ?? PACKAGE_ROOT, "source root");
  const root = canonicalPath(options.root, "Zouroboros root");
  assertZouroborosRoot(root);
  const factoryDir = canonicalPath(options.factoryDir ?? join(root, FACTORY_RELATIVE_DIR), "factory directory");
  assertContained(root, factoryDir);
  const templateLibraryDir = canonicalPath(join(root, TEMPLATE_LIBRARY_RELATIVE_DIR), "template library directory");
  assertContained(root, templateLibraryDir);
  const stateDir = canonicalPath(
    options.stateDir ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "zouroboros", "factory"),
    "factory state directory",
  );
  const existingFactory = existsSync(factoryDir) && readdirSync(factoryDir).length > 0;
  const existingTemplateLibrary = existsSync(templateLibraryDir) && readdirSync(templateLibraryDir).length > 0;
  if ((existingFactory || existingTemplateLibrary) && !options.force) {
    const existing = [existingFactory ? factoryDir : "", existingTemplateLibrary ? templateLibraryDir : ""].filter(Boolean).join(", ");
    throw new Error(`${existing} already exists; use --force for a code-only update`);
  }

  mkdirSync(factoryDir, { recursive: true });
  let copiedFiles = 0;
  for (const directory of COPY_DIRECTORIES) {
    copiedFiles += copyTree(sourceRoot, join(sourceRoot, directory), factoryDir, join(factoryDir, directory));
  }
  for (const file of COPY_FILES) {
    copiedFiles += copyTree(sourceRoot, join(sourceRoot, file), factoryDir, join(factoryDir, file));
  }
  copiedFiles += copyTree(
    sourceRoot,
    join(sourceRoot, "config", "factory-state-owners-v1.json"),
    factoryDir,
    join(factoryDir, "config", "factory-state-owners-v1.json"),
  );
  copiedFiles += copyTree(
    sourceRoot,
    join(sourceRoot, TEMPLATE_LIBRARY_SOURCE_DIR),
    root,
    templateLibraryDir,
  );
  copiedFiles += copyTemplateLibraryRuntimeDependencies(sourceRoot, root, templateLibraryDir);

  const templateLibraryChecks = templateLibraryBoundaryChecks(templateLibraryDir);
  const templateLibraryFailures = templateLibraryChecks.filter((check) => check.status === "FAIL");
  if (templateLibraryFailures.length) {
    throw new Error(`installed template library failed verification: ${templateLibraryFailures.map((check) => `${check.label}: ${check.detail}`).join("; ")}`);
  }
  const templateLibraryDistribution = readTemplateLibraryDistribution(templateLibraryDir);

  initializeStateRoot(stateDir);
  const configPath = join(factoryDir, "config", "runtime-flags.json");
  let config: InstallResult["config"] = "created";
  if (existsSync(configPath) && !options.resetConfig) {
    config = "preserved";
  } else {
    config = existsSync(configPath) ? "reset" : "created";
    writeAtomic(configPath, safeRuntimeConfig(sourceRoot, root, stateDir), 0o600);
  }

  const envPath = join(factoryDir, "factory.env");
  if (!existsSync(envPath) || options.resetConfig) {
    writeAtomic(envPath, [
      `export ZOUROBOROS_ROOT=${shellQuote(root)}`,
      `export ZOUROBOROS_WORKSPACE=${shellQuote(root)}`,
      `export FACTORY_STATE_DIR=${shellQuote(stateDir)}`,
      "",
    ].join("\n"), 0o600);
  }

  const packageVersion = readPackageVersion(sourceRoot);
  writeAtomic(join(factoryDir, ".factory-package.json"), `${JSON.stringify({
    schema_version: 1,
    package: "zouroboros-factory",
    package_version: packageVersion,
    installed_at: new Date().toISOString(),
    root,
    factory_dir: factoryDir,
    template_library_dir: templateLibraryDir,
    state_dir: stateDir,
    template_library: {
      catalog_version: templateLibraryDistribution.catalog_version,
      tooling_version: templateLibraryDistribution.tooling_version,
      catalog_sha256: templateLibraryDistribution.catalog_sha256,
      manifest_index_sha256: templateLibraryDistribution.manifest_index_sha256,
      execution_authority: false,
    },
    scheduler_configured: false,
    excluded: ["state", "evaluations", "investigations", "serial promotions", "executor credentials", "experiment artifacts"],
  }, null, 2)}\n`, 0o600);

  return {
    root,
    factory_dir: factoryDir,
    template_library_dir: templateLibraryDir,
    state_dir: stateDir,
    package_version: packageVersion,
    template_library_catalog_version: templateLibraryDistribution.catalog_version,
    template_library_tooling_version: templateLibraryDistribution.tooling_version,
    config,
    copied_files: copiedFiles,
    scheduler_configured: false,
  };
}

function executableCheck(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function validateStateMarker(stateDir: string): string | null {
  try {
    const stat = lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(stateDir) !== stateDir) return "state root is not a canonical real directory";
    const marker = JSON.parse(readFileSync(join(stateDir, STATE_MARKER), "utf8")) as Record<string, unknown>;
    if (marker.namespace !== "zouroboros-software-factory" || marker.schema_version !== 1) return "state marker identity is invalid";
    if (marker.canonical_path !== stateDir || marker.device !== stat.dev) return "state marker does not match the state root";
    if (typeof marker.root_id !== "string" || !/^[0-9a-f-]{36}$/i.test(marker.root_id)) return "state marker root_id is invalid";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function doctorFactory(rootInput: string, factoryDirInput?: string): DoctorResult {
  const root = canonicalPath(rootInput, "Zouroboros root");
  const factoryDir = canonicalPath(factoryDirInput ?? join(root, FACTORY_RELATIVE_DIR), "factory directory");
  const templateLibraryDir = canonicalPath(join(root, TEMPLATE_LIBRARY_RELATIVE_DIR), "template library directory");
  const checks: DoctorCheck[] = [];
  checks.push({ status: executableCheck("bun") ? "PASS" : "FAIL", label: "Bun runtime", detail: executableCheck("bun") ? "available" : "bun is not on PATH" });
  checks.push({ status: executableCheck("git") ? "PASS" : "FAIL", label: "Git runtime", detail: executableCheck("git") ? "available" : "git is not on PATH" });
  for (const file of REQUIRED_FACTORY_FILES) {
    checks.push({ status: existsSync(join(factoryDir, file)) ? "PASS" : "FAIL", label: file, detail: existsSync(join(factoryDir, file)) ? "present" : "missing" });
  }
  checks.push(...templateLibraryBoundaryChecks(templateLibraryDir));

  let stateDir = "";
  try {
    const manifest = JSON.parse(readFileSync(join(factoryDir, ".factory-package.json"), "utf8")) as { state_dir?: unknown; template_library_dir?: unknown };
    stateDir = typeof manifest.state_dir === "string" ? canonicalPath(manifest.state_dir, "manifest state directory") : "";
    checks.push({
      status: manifest.template_library_dir === templateLibraryDir ? "PASS" : "FAIL",
      label: "template library install manifest",
      detail: manifest.template_library_dir === templateLibraryDir ? templateLibraryDir : "installed component path is missing or mismatched",
    });
  } catch {
    checks.push({ status: "FAIL", label: "install manifest", detail: ".factory-package.json is missing or invalid" });
  }
  if (stateDir) {
    const markerError = validateStateMarker(stateDir);
    checks.push({ status: markerError ? "FAIL" : "PASS", label: "state boundary", detail: markerError ?? stateDir });
  }

  const runtimeValidation = spawnSync("bun", [join(factoryDir, "scripts", "runtime-config.ts"), "validate"], {
    cwd: factoryDir,
    env: { ...process.env, FACTORY_STATE_DIR: stateDir || process.env.FACTORY_STATE_DIR || "", FACTORY_STATE_MODE: "production" },
    encoding: "utf8",
  });
  checks.push({
    status: runtimeValidation.status === 0 ? "PASS" : "FAIL",
    label: "runtime configuration",
    detail: runtimeValidation.status === 0 ? runtimeValidation.stdout.trim() : (runtimeValidation.stderr || runtimeValidation.stdout).trim().slice(0, 500),
  });

  const templateLibraryValidation = spawnSync("bun", [join(templateLibraryDir, "scripts", "template-library.ts"), "validate"], {
    cwd: templateLibraryDir,
    env: { ...process.env, ZOUROBOROS_ROOT: root, ZOUROBOROS_WORKSPACE: root },
    encoding: "utf8",
  });
  checks.push({
    status: templateLibraryValidation.status === 0 ? "PASS" : "FAIL",
    label: "template library runtime validation",
    detail: templateLibraryValidation.status === 0
      ? templateLibraryValidation.stdout.trim()
      : (templateLibraryValidation.stderr || templateLibraryValidation.stdout).trim().slice(0, 500),
  });

  for (const path of [
    "packages/swarm",
    "packages/workflow",
    "Skills/zouroboros-governance",
    "packages/capability-runtime",
    "packages/modal-exec",
  ]) {
    checks.push({
      status: existsSync(join(root, path)) ? "PASS" : "WARN",
      label: path,
      detail: existsSync(join(root, path)) ? "integration source available" : "optional advanced integration unavailable",
    });
  }
  checks.push({
    status: "WARN",
    label: "conveyor trigger",
    detail: "not configured by this package; wire a scheduler or automation only after smoke verification and operator approval",
  });
  return { ok: checks.every((check) => check.status !== "FAIL"), root, factory_dir: factoryDir, template_library_dir: templateLibraryDir, checks };
}

export function packageCheck(sourceRoot = PACKAGE_ROOT): { ok: boolean; checks: DoctorCheck[] } {
  const root = canonicalPath(sourceRoot, "source root");
  const checks: DoctorCheck[] = [];
  for (const path of [...COPY_DIRECTORIES, ...COPY_FILES, TEMPLATE_LIBRARY_SOURCE_DIR, "templates/config/runtime-flags.json", "config/factory-state-owners-v1.json"]) {
    checks.push({ status: existsSync(join(root, path)) ? "PASS" : "FAIL", label: path, detail: existsSync(join(root, path)) ? "packaged" : "missing" });
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  const templateLibraryPublished = (manifest.files ?? []).some((entry) => entry === `${TEMPLATE_LIBRARY_SOURCE_DIR}/` || entry === TEMPLATE_LIBRARY_SOURCE_DIR);
  checks.push({
    status: templateLibraryPublished ? "PASS" : "FAIL",
    label: "publish template library",
    detail: templateLibraryPublished ? "software-template-library/ is included in package files" : "software-template-library/ is absent from package files",
  });
  const unsafe = ["state", "evaluations", "config/runtime-flags.json", "config/serial-promotions"];
  for (const path of unsafe) {
    const included = (manifest.files ?? []).some((entry) => entry === path || entry.startsWith(`${path}/`));
    checks.push({ status: included ? "FAIL" : "PASS", label: `exclude ${path}`, detail: included ? "unsafe runtime material is publishable" : "excluded" });
  }
  const template = JSON.parse(readFileSync(join(root, "templates", "config", "runtime-flags.json"), "utf8")) as { flags: Record<string, string> };
  const activationValues = new Set(["1", "shadow", "enforce", "act", "labeled", "unlabeled"]);
  const activated = Object.entries(template.flags).filter(([key, value]) =>
    activationValues.has(value) && !["SF003_POOL_MAX_DISPATCH", "SF_PRESPEC_TOP_N", "SF_PRESPEC_COOLDOWN_HOURS", "FACTORY_INFLIGHT_CAP"].includes(key),
  );
  checks.push({
    status: activated.length === 0 ? "PASS" : "FAIL",
    label: "safe runtime defaults",
    detail: activated.length === 0 ? "all execution and promotion lanes default off" : activated.map(([key]) => key).join(", "),
  });
  checks.push(...templateLibraryBoundaryChecks(join(root, TEMPLATE_LIBRARY_SOURCE_DIR)));
  return { ok: checks.every((check) => check.status !== "FAIL"), checks };
}

function smokeFactory(rootInput: string): number {
  const root = canonicalPath(rootInput, "Zouroboros root");
  assertZouroborosRoot(root);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "zouroboros-factory-package-"));
  try {
    writeFileSync(join(temporaryRoot, "package.json"), "{\"name\":\"factory-smoke\",\"private\":true}\n");
    symlinkSync(join(root, "packages"), join(temporaryRoot, "packages"), "dir");
    if (existsSync(join(root, "Skills"))) symlinkSync(join(root, "Skills"), join(temporaryRoot, "Skills"), "dir");
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(temporaryRoot, "node_modules"), "dir");
    const installed = installFactory({
      root: temporaryRoot,
      sourceRoot: PACKAGE_ROOT,
      stateDir: join(temporaryRoot, "factory-state"),
    });
    const templateLibraryScript = join(installed.template_library_dir, "scripts", "template-library.ts");
    const templateValidation = spawnSync("bun", [templateLibraryScript, "validate"], {
      cwd: installed.template_library_dir,
      env: { ...process.env, ZOUROBOROS_ROOT: temporaryRoot, ZOUROBOROS_WORKSPACE: temporaryRoot },
      encoding: "utf8",
    });
    process.stdout.write(templateValidation.stdout || "");
    process.stderr.write(templateValidation.stderr || "");
    if (templateValidation.status !== 0) return templateValidation.status ?? 1;

    const resolvedTemplate = join(temporaryRoot, "resolved-web-app-template.json");
    const templateResolution = spawnSync("bun", [
      templateLibraryScript,
      "resolve",
      "--template",
      "web-app@1.0.0",
      "--level",
      "standard",
      "--output",
      resolvedTemplate,
    ], {
      cwd: installed.template_library_dir,
      env: { ...process.env, ZOUROBOROS_ROOT: temporaryRoot, ZOUROBOROS_WORKSPACE: temporaryRoot },
      encoding: "utf8",
    });
    process.stdout.write(templateResolution.stdout || "");
    process.stderr.write(templateResolution.stderr || "");
    if (templateResolution.status !== 0 || !existsSync(resolvedTemplate)) return templateResolution.status ?? 1;

    const result = spawnSync("bun", [join(installed.factory_dir, "scripts", "factory-mvp.ts"), "smoke"], {
      cwd: installed.factory_dir,
      env: {
        ...process.env,
        ZOUROBOROS_WORKSPACE: temporaryRoot,
        FACTORY_STATE_MODE: "compatibility",
        FACTORY_PERSONA_ROUTING_MODE: "off",
        FACTORY_MODEL_REVIEW: "off",
      },
      encoding: "utf8",
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    return result.status ?? 1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function findZouroborosRoot(start = process.cwd()): string {
  let candidate = resolve(start);
  while (true) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "packages"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("cannot locate a Zouroboros checkout; pass --root <path>");
}

function usage(): string {
  return `Zouroboros Factory\n\nCommands:\n  install [--root <checkout>] [--dir <factory-dir>] [--state-dir <dir>] [--force] [--reset-config] [--json]\n  doctor [--root <checkout>] [--dir <factory-dir>] [--json]\n  smoke [--root <checkout>]\n  package-check [--json]\n`;
}

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.label}: ${check.detail}`);
}

export async function runFactoryPackageCli(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help" || parsed.flags.has("help")) {
    console.log(usage());
    return 0;
  }
  if (parsed.command === "package-check") {
    const result = packageCheck();
    if (parsed.flags.has("json")) console.log(JSON.stringify(result, null, 2));
    else printChecks(result.checks);
    return result.ok ? 0 : 1;
  }
  const root = canonicalPath(stringFlag(parsed.flags, "root") ?? findZouroborosRoot(), "Zouroboros root");
  if (parsed.command === "install") {
    const result = installFactory({
      root,
      factoryDir: stringFlag(parsed.flags, "dir"),
      stateDir: stringFlag(parsed.flags, "state-dir"),
      force: parsed.flags.has("force"),
      resetConfig: parsed.flags.has("reset-config"),
    });
    if (parsed.flags.has("json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Installed zouroboros-factory ${result.package_version} to ${result.factory_dir}`);
      console.log(`Software Template Library ${result.template_library_catalog_version}/${result.template_library_tooling_version}: ${result.template_library_dir}`);
      console.log(`State root: ${result.state_dir}`);
      console.log(`Runtime config: ${result.config}; conveyor trigger: not configured`);
    }
    return 0;
  }
  if (parsed.command === "doctor") {
    const result = doctorFactory(root, stringFlag(parsed.flags, "dir"));
    if (parsed.flags.has("json")) console.log(JSON.stringify(result, null, 2));
    else printChecks(result.checks);
    return result.ok ? 0 : 1;
  }
  if (parsed.command === "smoke") return smokeFactory(root);
  console.error(`unknown command: ${parsed.command}\n\n${usage()}`);
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await runFactoryPackageCli();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
