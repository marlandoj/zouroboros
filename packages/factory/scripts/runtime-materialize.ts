#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const REQUIRED_PNPM_VERSION = "8.15.0";
export const MATERIALIZE_FLAGS = ["--offline", "--frozen-lockfile", "--ignore-scripts"] as const;

export interface RuntimeMaterializationAttestation {
  version: 1;
  candidate_root: string;
  merge_commit: string;
  merge_tree: string;
  package_json_sha256: string;
  pnpm_lock_sha256: string;
  pnpm_workspace_sha256: string;
  pnpm_version: string;
  bun_version: string;
  os: string;
  arch: string;
  install_flags: string[];
  normalized_dependency_graph_sha256: string;
  template_library_ajv_entrypoint: string;
  template_library_ajv_version: string;
  runtime_key_sha256: string;
  dependency_link_count: number;
  tracked_clean: boolean;
}

export class RuntimeMaterializationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeMaterializationError";
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new RuntimeMaterializationError("command_failed", `${command} ${args.join(" ")} failed (${exit}): ${stderr || stdout}`);
  return stdout.trim();
}

function canonicalCandidate(path: string): string {
  if (!path || !isAbsolute(path) || path.includes("\0") || resolve(path) !== path || path === sep) {
    throw new RuntimeMaterializationError("candidate_invalid", "candidate root must be a canonical absolute path");
  }
  const allowedRuntime = "/home/workspace/.runtime/factory-conveyor-state-boundary-";
  const allowedTest = resolve(process.env.RUNTIME_MATERIALIZE_TEST_ROOT ?? "/tmp/runtime-materialize-test");
  if (!path.startsWith(allowedRuntime) && !(process.env.RUNTIME_MATERIALIZE_TEST_MODE === "1" && (path === allowedTest || path.startsWith(`${allowedTest}${sep}`)))) {
    throw new RuntimeMaterializationError("candidate_out_of_scope", "candidate root is outside the authorized inactive-runtime namespace");
  }
  return path;
}

export function normalizeDependencyGraph(value: unknown, candidateRoot: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDependencyGraph(entry, candidateRoot)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter((key) => !["path", "resolved", "dev"].includes(key)).map((key) => [key, normalizeDependencyGraph(record[key], candidateRoot)]));
  }
  if (typeof value === "string") return value.replaceAll(candidateRoot, "<runtime>");
  return value;
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function auditDependencyLinks(candidateRoot: string): { links: number; violations: string[] } {
  const rootNodeModules = join(candidateRoot, "node_modules");
  if (!existsSync(rootNodeModules)) throw new RuntimeMaterializationError("node_modules_missing", "candidate node_modules is missing");
  let links = 0;
  const violations: string[] = [];
  const auditTree = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        links += 1;
        const target = realpathSync(path);
        if (!isContained(candidateRoot, target)) violations.push(`${relative(candidateRoot, path)} -> ${target}`);
        continue;
      }
      if (stat.isDirectory()) auditTree(path);
    }
  };
  const discoverBoundaries = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (name === "node_modules") {
        auditTree(path);
        continue;
      }
      discoverBoundaries(path);
    }
  };
  discoverBoundaries(candidateRoot);
  return { links, violations: violations.sort() };
}

export function resolveTemplateLibraryAjv(candidateRoot: string): { entrypoint: string; version: string } {
  const projectManifest = [
    join(candidateRoot, "Projects", "software-template-library", "package.json"),
    join(candidateRoot, "packages", "factory", "software-template-library", "package.json"),
  ].find((manifest) => existsSync(manifest));
  if (!projectManifest) {
    throw new RuntimeMaterializationError("template_library_missing", "software-template-library package manifest is missing");
  }
  const requireFromProject = createRequire(projectManifest);
  let entrypoint: string;
  let dependencyManifest: string;
  try {
    entrypoint = realpathSync(requireFromProject.resolve("ajv/dist/2020"));
    dependencyManifest = realpathSync(requireFromProject.resolve("ajv/package.json"));
  } catch (error) {
    throw new RuntimeMaterializationError("template_library_ajv_unresolved", `software-template-library Ajv entrypoint is unresolved: ${String(error)}`);
  }
  if (!isContained(candidateRoot, entrypoint) || !isContained(candidateRoot, dependencyManifest)) {
    throw new RuntimeMaterializationError("template_library_ajv_external", "software-template-library Ajv resolves outside the candidate runtime");
  }
  const version = (JSON.parse(readFileSync(dependencyManifest, "utf8")) as { version?: unknown }).version;
  if (version !== "8.17.1") {
    throw new RuntimeMaterializationError("template_library_ajv_version", `expected software-template-library Ajv 8.17.1, found ${String(version)}`);
  }
  return { entrypoint: relative(candidateRoot, entrypoint).split(sep).join("/"), version };
}

export function runtimeKey(input: Omit<RuntimeMaterializationAttestation, "version" | "candidate_root" | "normalized_dependency_graph_sha256" | "runtime_key_sha256" | "dependency_link_count" | "tracked_clean"> & { normalized_dependency_graph_sha256: string }): string {
  return sha256(JSON.stringify({
    merge_commit: input.merge_commit,
    merge_tree: input.merge_tree,
    package_json_sha256: input.package_json_sha256,
    pnpm_lock_sha256: input.pnpm_lock_sha256,
    pnpm_workspace_sha256: input.pnpm_workspace_sha256,
    pnpm_version: input.pnpm_version,
    bun_version: input.bun_version,
    os: input.os,
    arch: input.arch,
    install_flags: input.install_flags,
    normalized_dependency_graph_sha256: input.normalized_dependency_graph_sha256,
    template_library_ajv_entrypoint: input.template_library_ajv_entrypoint,
    template_library_ajv_version: input.template_library_ajv_version,
  }));
}

export async function materializeRuntime(sourceRootInput: string, commit: string, candidateInput: string): Promise<RuntimeMaterializationAttestation> {
  const sourceRoot = resolve(sourceRootInput);
  const candidateRoot = canonicalCandidate(candidateInput);
  if (existsSync(candidateRoot)) throw new RuntimeMaterializationError("candidate_exists", "candidate root must not exist");
  const repositoryRoot = await run("git", ["rev-parse", "--show-toplevel"], sourceRoot);
  const exactCommit = await run("git", ["rev-parse", `${commit}^{commit}`], sourceRoot);
  const mergeTree = await run("git", ["rev-parse", `${exactCommit}^{tree}`], sourceRoot);
  await run("git", ["worktree", "add", "--detach", candidateRoot, exactCommit], repositoryRoot);

  const pnpmVersion = await run("pnpm", ["--version"], candidateRoot);
  if (pnpmVersion !== REQUIRED_PNPM_VERSION) {
    throw new RuntimeMaterializationError("pnpm_version_mismatch", `expected pnpm ${REQUIRED_PNPM_VERSION}, found ${pnpmVersion}`);
  }
  await run("pnpm", ["install", ...MATERIALIZE_FLAGS], candidateRoot);

  const graphRaw = await run("pnpm", ["list", "--depth", "Infinity", "--json"], candidateRoot);
  const graph = normalizeDependencyGraph(JSON.parse(graphRaw), candidateRoot);
  const graphHash = sha256(JSON.stringify(graph));
  const linkAudit = auditDependencyLinks(candidateRoot);
  if (linkAudit.violations.length) throw new RuntimeMaterializationError("cross_runtime_link", linkAudit.violations.join("\n"));
  const templateLibraryAjv = resolveTemplateLibraryAjv(candidateRoot);
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], candidateRoot);
  if (status) throw new RuntimeMaterializationError("tracked_drift", `candidate source is not clean:\n${status}`);

  const keyInput = {
    merge_commit: exactCommit,
    merge_tree: mergeTree,
    package_json_sha256: sha256(readFileSync(join(candidateRoot, "package.json"))),
    pnpm_lock_sha256: sha256(readFileSync(join(candidateRoot, "pnpm-lock.yaml"))),
    pnpm_workspace_sha256: sha256(readFileSync(join(candidateRoot, "pnpm-workspace.yaml"))),
    pnpm_version: pnpmVersion,
    bun_version: Bun.version,
    os: platform(),
    arch: arch(),
    install_flags: [...MATERIALIZE_FLAGS],
    normalized_dependency_graph_sha256: graphHash,
    template_library_ajv_entrypoint: templateLibraryAjv.entrypoint,
    template_library_ajv_version: templateLibraryAjv.version,
  };
  return {
    version: 1,
    candidate_root: candidateRoot,
    ...keyInput,
    runtime_key_sha256: runtimeKey(keyInput),
    dependency_link_count: linkAudit.links,
    tracked_clean: true,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (command !== "materialize") throw new RuntimeMaterializationError("usage", "usage: runtime-materialize.ts materialize --source <repo> --commit <sha> --candidate <path>");
  const source = value("--source");
  const commit = value("--commit");
  const candidate = value("--candidate");
  if (!source || !commit || !candidate) throw new RuntimeMaterializationError("usage", "materialize requires --source, --commit, and --candidate");
  console.log(JSON.stringify(await materializeRuntime(source, commit, candidate), null, 2));
}
