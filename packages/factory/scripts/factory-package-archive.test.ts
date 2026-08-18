import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const tarball = process.env.FACTORY_TARBALL;
if (!tarball) throw new Error("FACTORY_TARBALL must point to a packed zouroboros-factory archive");

const repositoryRoot = resolve(import.meta.dir, "../../..");
const root = mkdtempSync(join(tmpdir(), "factory-archive-test-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "signal"})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

test("extracted tarball installs and runs both factory components", () => {
  const extractionRoot = join(root, "archive");
  const dependencyRoot = join(root, "dependencies");
  const targetRoot = join(root, "target");
  mkdirSync(extractionRoot, { recursive: true });
  mkdirSync(dependencyRoot, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  run("tar", ["-xzf", resolve(tarball), "-C", extractionRoot], root);
  const packageRoot = join(extractionRoot, "package");

  writeFileSync(join(dependencyRoot, "package.json"), "{\"name\":\"factory-archive-dependencies\",\"private\":true}\n");
  run("pnpm", ["add", "ajv@8.17.1", "--ignore-workspace"], dependencyRoot);
  symlinkSync(join(dependencyRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");

  writeFileSync(join(targetRoot, "package.json"), "{\"name\":\"factory-archive-target\",\"private\":true}\n");
  symlinkSync(join(repositoryRoot, "packages"), join(targetRoot, "packages"), "dir");
  symlinkSync(join(repositoryRoot, "Skills"), join(targetRoot, "Skills"), "dir");
  symlinkSync(join(repositoryRoot, "node_modules"), join(targetRoot, "node_modules"), "dir");

  const cli = join(packageRoot, "scripts", "factory-package-cli.ts");
  run("bun", [cli, "package-check"], packageRoot);
  run("bun", [cli, "install", "--root", targetRoot, "--state-dir", join(targetRoot, "factory-state"), "--json"], packageRoot);
  run("bun", [cli, "doctor", "--root", targetRoot, "--json"], packageRoot);
  run("bun", [cli, "smoke", "--root", targetRoot], packageRoot);

  const libraryRoot = join(targetRoot, "Projects", "software-template-library");
  const distribution = JSON.parse(readFileSync(join(libraryRoot, "distribution.json"), "utf8"));
  expect(distribution.catalog_version).toBe("1.0.0");
  expect(distribution.tooling_version).toBe("1.0.1");
  expect(existsSync(join(libraryRoot, "node_modules", "ajv", "dist", "2020.js"))).toBe(true);
  expect(existsSync(join(libraryRoot, "evaluations"))).toBe(false);
  expect(existsSync(join(targetRoot, "Projects", "zouroboros-software-factory", ".factory-package.json"))).toBe(true);
});
