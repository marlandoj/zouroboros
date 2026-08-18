import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctorFactory, installFactory, packageCheck } from "./factory-package-cli";

const roots: string[] = [];
const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(import.meta.dir, "../../..");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-package-test-"));
  roots.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });
  symlinkSync(join(repositoryRoot, "Skills"), join(root, "Skills"), "dir");
  if (existsSync(join(repositoryRoot, "node_modules"))) {
    symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir");
  }
  writeFileSync(join(root, "package.json"), "{\"name\":\"test-checkout\",\"private\":true}\n");
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("factory package", () => {
  test("publishable boundary excludes runtime material", () => {
    const result = packageCheck();
    expect(result.ok).toBe(true);
    expect(result.checks.filter((check) => check.status === "FAIL")).toEqual([]);
  });

  test("installer materializes safe components and independent state", () => {
    const root = checkout();
    const stateDir = join(root, "factory-state");
    const result = installFactory({ root, stateDir });
    expect(result.scheduler_configured).toBe(false);
    expect(existsSync(join(result.factory_dir, "scripts", "dispatcher.ts"))).toBe(true);
    expect(existsSync(join(result.factory_dir, "scripts", "swarm-decision-gate.ts"))).toBe(true);
    expect(existsSync(join(result.factory_dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(result.factory_dir, "contracts", "factory-runtime-state-v1.md"))).toBe(true);
    expect(existsSync(join(result.factory_dir, "game-gauntlet", "scripts", "game-seed-preflight.ts"))).toBe(true);
    expect(result.template_library_catalog_version).toBe("1.0.0");
    expect(result.template_library_tooling_version).toBe("1.0.1");
    expect(existsSync(join(result.template_library_dir, "scripts", "template-library.ts"))).toBe(true);
    expect(existsSync(join(result.template_library_dir, "templates", "generated", "web-app", "standard.manifest.json"))).toBe(true);
    expect(existsSync(join(result.template_library_dir, "evaluations"))).toBe(false);
    expect(existsSync(join(result.template_library_dir, "scripts", "sync-linear.ts"))).toBe(false);
    expect(sha256(join(result.template_library_dir, "library", "template-library.json"))).toBe("fd5485d1e87a9064170691c19d4c7f30354aaade25a86fea763ac3f26c2059d3");
    expect(existsSync(join(result.factory_dir, "evaluations"))).toBe(false);
    expect(existsSync(join(result.factory_dir, "state"))).toBe(false);
    const config = JSON.parse(readFileSync(join(result.factory_dir, "config", "runtime-flags.json"), "utf8"));
    expect(config.flags.SF_LINEAR_SYNC).toBe("0");
    expect(config.flags.SF010_AUTOMERGE).toBe("0");
    expect(config.flags.FACTORY_MODEL_REVIEW).toBe("off");
    expect(config.flags.FACTORY_RECEIPT_SHADOW_DB_PATH.startsWith(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, ".factory-state-root.json"))).toBe(true);
  });

  test("code update preserves operator runtime configuration", () => {
    const root = checkout();
    const stateDir = join(root, "factory-state");
    const first = installFactory({ root, stateDir });
    const configPath = join(first.factory_dir, "config", "runtime-flags.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.flags.SF004_METRICS = "1";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => installFactory({ root, stateDir })).toThrow("already exists");
    const updated = installFactory({ root, stateDir, force: true });
    expect(updated.config).toBe("preserved");
    expect(JSON.parse(readFileSync(configPath, "utf8")).flags.SF004_METRICS).toBe("1");
    expect(sha256(join(updated.template_library_dir, "library", "template-library.json"))).toBe("fd5485d1e87a9064170691c19d4c7f30354aaade25a86fea763ac3f26c2059d3");
  });

  test("doctor validates the required package and state boundary", () => {
    const root = checkout();
    const installed = installFactory({ root, stateDir: join(root, "factory-state") });
    const result = doctorFactory(root, installed.factory_dir);
    expect(result.ok).toBe(true);
    expect(result.template_library_dir).toBe(installed.template_library_dir);
    expect(result.checks.some((check) => check.label === "template library runtime validation" && check.status === "PASS")).toBe(true);
    expect(result.checks.some((check) => check.label === "conveyor trigger" && check.status === "WARN")).toBe(true);
  });

  test("package check rejects published template catalog drift", () => {
    const source = mkdtempSync(join(tmpdir(), "factory-package-source-"));
    roots.push(source);
    cpSync(packageRoot, source, { recursive: true });
    const catalogPath = join(source, "software-template-library", "library", "template-library.json");
    writeFileSync(catalogPath, `${readFileSync(catalogPath, "utf8")}\n`);
    const result = packageCheck(source);
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.label === "template library hash library/template-library.json" && check.status === "FAIL")).toBe(true);
  });
});
