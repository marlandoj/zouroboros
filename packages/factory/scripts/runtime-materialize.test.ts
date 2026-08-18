import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditDependencyLinks, normalizeDependencyGraph, resolveTemplateLibraryAjv, runtimeKey } from "./runtime-materialize";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime materialization", () => {
  test("normalizes path and ordering differences into one graph", () => {
    const a = "/tmp/runtime-a";
    const b = "/tmp/runtime-b";
    const graphA = [{ path: a, dependencies: { z: { version: "1" }, a: { version: "2", resolved: `${a}/node_modules/a` } } }];
    const graphB = [{ path: b, dependencies: { a: { resolved: `${b}/node_modules/a`, version: "2" }, z: { version: "1" } } }];
    expect(normalizeDependencyGraph(graphA, a)).toEqual(normalizeDependencyGraph(graphB, b));
  });

  test("accepts candidate-local links and rejects cross-runtime links", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-links-"));
    roots.push(root);
    const localPackage = join(root, "packages", "local");
    mkdirSync(localPackage, { recursive: true });
    mkdirSync(join(root, "node_modules"));
    symlinkSync(localPackage, join(root, "node_modules", "local"));
    expect(auditDependencyLinks(root).violations).toEqual([]);

    const other = mkdtempSync(join(tmpdir(), "runtime-materialize-other-"));
    roots.push(other);
    writeFileSync(join(other, "package.json"), "{}");
    symlinkSync(other, join(root, "node_modules", "other"));
    expect(auditDependencyLinks(root).violations[0]).toContain(other);
  });

  test("audits nested workspace node_modules boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-nested-links-"));
    roots.push(root);
    mkdirSync(join(root, "node_modules"));
    const nestedNodeModules = join(root, "Projects", "nested", "node_modules");
    mkdirSync(nestedNodeModules, { recursive: true });
    const localPackage = join(root, ".pnpm", "local");
    mkdirSync(localPackage, { recursive: true });
    symlinkSync(localPackage, join(nestedNodeModules, "local"));
    expect(auditDependencyLinks(root)).toEqual({ links: 1, violations: [] });

    const other = mkdtempSync(join(tmpdir(), "runtime-materialize-nested-other-"));
    roots.push(other);
    symlinkSync(other, join(nestedNodeModules, "other"));
    expect(auditDependencyLinks(root).violations[0]).toContain("Projects/nested/node_modules/other");
  });

  test("resolves the exact template-library Ajv entrypoint inside the candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-ajv-"));
    roots.push(root);
    const project = join(root, "Projects", "software-template-library");
    const ajv = join(root, ".pnpm", "ajv@8.17.1", "node_modules", "ajv");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    mkdirSync(join(ajv, "dist"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(ajv, "package.json"), JSON.stringify({ name: "ajv", version: "8.17.1" }));
    writeFileSync(join(ajv, "dist", "2020.js"), "module.exports = {};");
    symlinkSync(ajv, join(project, "node_modules", "ajv"));
    expect(resolveTemplateLibraryAjv(root)).toEqual({
      entrypoint: ".pnpm/ajv@8.17.1/node_modules/ajv/dist/2020.js",
      version: "8.17.1",
    });
  });

  test("resolves Ajv from the packaged template-library source layout", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-packaged-ajv-"));
    roots.push(root);
    const project = join(root, "packages", "factory", "software-template-library");
    const ajv = join(root, ".pnpm", "ajv@8.17.1", "node_modules", "ajv");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, "packages", "factory", "node_modules"), { recursive: true });
    mkdirSync(join(ajv, "dist"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(ajv, "package.json"), JSON.stringify({ name: "ajv", version: "8.17.1" }));
    writeFileSync(join(ajv, "dist", "2020.js"), "module.exports = {};");
    symlinkSync(ajv, join(root, "packages", "factory", "node_modules", "ajv"));
    expect(resolveTemplateLibraryAjv(root)).toEqual({
      entrypoint: ".pnpm/ajv@8.17.1/node_modules/ajv/dist/2020.js",
      version: "8.17.1",
    });
  });

  test("runtime key changes with dependency graph or platform input", () => {
    const base = {
      merge_commit: "a".repeat(40),
      merge_tree: "b".repeat(40),
      package_json_sha256: "c".repeat(64),
      pnpm_lock_sha256: "d".repeat(64),
      pnpm_workspace_sha256: "e".repeat(64),
      pnpm_version: "8.15.0",
      bun_version: "1.3.12",
      os: "linux",
      arch: "x64",
      install_flags: ["--offline", "--frozen-lockfile", "--ignore-scripts"],
      normalized_dependency_graph_sha256: "f".repeat(64),
      template_library_ajv_entrypoint: ".pnpm/ajv@8.17.1/node_modules/ajv/dist/2020.js",
      template_library_ajv_version: "8.17.1",
    };
    expect(runtimeKey(base)).not.toBe(runtimeKey({ ...base, normalized_dependency_graph_sha256: "0".repeat(64) }));
    expect(runtimeKey(base)).not.toBe(runtimeKey({ ...base, arch: "arm64" }));
  });
});
