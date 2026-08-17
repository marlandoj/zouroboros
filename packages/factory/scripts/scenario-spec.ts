#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-009 T1 — Scenario spec core.
 *
 * A ScenarioSpec is one ephemeral verification run: N shell steps executed in
 * a throwaway workdir under the P0-3 hermetic sandbox, optionally against a
 * deterministic digital twin (SF-009 v1 ships a Linear contract-mock).
 * This module is the pure layer: parse/validate the spec (fail-loud). The
 * runner (scenario-run.ts) owns spawning, the twin lifecycle, and the ledger.
 *
 * Env forwarding rule: `env` values are LITERALS from the committed spec —
 * nothing is ever forwarded from the parent environment. Names are still
 * secret-checked at parse (isSecretEnvName) so a spec can never normalize
 * committing real credential conventions.
 *
 * Placeholders materialized by the runner inside `run` commands:
 *   {scripts_dir} → this scripts/ directory   {workdir} → the run's temp dir
 *
 * CLI (validation only, writes nothing):
 *   bun scenario-spec.ts validate --spec <yaml>   (requires SF009_SCENARIOS=1)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSecretEnvName } from "../../../packages/selfheal/src/crystallize/eval-replay.ts";

// ─── Flags ────────────────────────────────────────────────────────────────────

/** SF009_SCENARIOS default OFF — scenarios are an execution surface (SF-003 precedent). */
export function scenariosEnabled(): boolean {
  return process.env.SF009_SCENARIOS === "1";
}

// ─── Paths (env-injectable for the sandboxed selftest) ────────────────────────

export function scenarioRunsPath(): string {
  return resolveFactoryStateOverride(process.env.SF009_RUNS_PATH, "scenario-runs.jsonl");
}

// ─── Spec ─────────────────────────────────────────────────────────────────────

export interface TwinDecl {
  kind: "linear";
  /** Absolute path, resolved from the spec file's directory at parse time. */
  fixture: string;
}

export interface StepExpect {
  exit_code?: number;
  stdout_contains?: string[];
  stderr_contains?: string[];
  /** Workdir-relative paths; traversal ("..") and absolute paths rejected at parse. */
  files_exist?: string[];
}

export interface ScenarioStep {
  name: string;
  run: string;
  timeout_ms?: number;
  expect: StepExpect;
}

export interface ScenarioSpec {
  scenario_id: string;
  description?: string;
  /** Drives the twin's PRNG — same seed ⇒ byte-identical twin transcript. */
  seed: number;
  twin?: TwinDecl;
  env?: Record<string, string>;
  steps: ScenarioStep[];
}

const EXPECT_KEYS = new Set(["exit_code", "stdout_contains", "stderr_contains", "files_exist"]);

function parseStringList(value: unknown, label: string): string[] {
  const arr = Array.isArray(value) ? value : [value];
  if (arr.length === 0 || arr.some((s) => typeof s !== "string" || s.trim() === "")) {
    throw new Error(`${label} must be a non-empty string or string array`);
  }
  return arr as string[];
}

function parseExpect(value: unknown, label: string): StepExpect {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}.expect must be an object with at least one expectation`);
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  const unknown = keys.filter((k) => !EXPECT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`${label}.expect has unknown keys: ${unknown.join(", ")} (allowed: ${[...EXPECT_KEYS].join(", ")})`);
  }
  if (keys.length === 0) throw new Error(`${label}.expect must declare at least one expectation`);

  const expect: StepExpect = {};
  if (raw.exit_code !== undefined) {
    const code = Number(raw.exit_code);
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new Error(`${label}.expect.exit_code must be an integer 0-255`);
    }
    expect.exit_code = code;
  }
  if (raw.stdout_contains !== undefined) expect.stdout_contains = parseStringList(raw.stdout_contains, `${label}.expect.stdout_contains`);
  if (raw.stderr_contains !== undefined) expect.stderr_contains = parseStringList(raw.stderr_contains, `${label}.expect.stderr_contains`);
  if (raw.files_exist !== undefined) {
    const files = parseStringList(raw.files_exist, `${label}.expect.files_exist`);
    for (const f of files) {
      if (isAbsolute(f) || f.split("/").includes("..")) {
        throw new Error(`${label}.expect.files_exist entries must be workdir-relative without "..": ${f}`);
      }
    }
    expect.files_exist = files;
  }
  return expect;
}

/** Fail-loud spec parser — a malformed committed scenario must never half-run. */
export function parseScenarioSpec(path: string): ScenarioSpec {
  if (!existsSync(path)) throw new Error(`scenario spec not found: ${path}`);
  const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") throw new Error(`scenario spec is not a YAML object: ${path}`);

  const id = doc.scenario_id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
    throw new Error(`scenario_id must match [a-z0-9][a-z0-9-]{2,63}: ${String(id)}`);
  }

  const seed = Number(doc.seed);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`seed must be a non-negative integer in ${path}`);
  }

  let twin: TwinDecl | undefined;
  if (doc.twin !== undefined) {
    const t = doc.twin as Record<string, unknown> | null;
    if (!t || typeof t !== "object") throw new Error(`twin must be an object in ${path}`);
    if (t.kind !== "linear") throw new Error(`twin.kind must be "linear" (v1): ${String(t.kind)}`);
    if (typeof t.fixture !== "string" || t.fixture.trim() === "") {
      throw new Error(`twin.fixture missing in ${path}`);
    }
    const fixture = resolve(dirname(path), t.fixture);
    if (!existsSync(fixture)) throw new Error(`twin.fixture not found: ${fixture}`);
    twin = { kind: "linear", fixture };
  }

  let env: Record<string, string> | undefined;
  if (doc.env !== undefined) {
    const e = doc.env as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`env must be a string map in ${path}`);
    env = {};
    for (const [name, value] of Object.entries(e)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`env name must be UPPER_SNAKE: ${name}`);
      if (isSecretEnvName(name)) throw new Error(`env name matches a secret convention, refuse to forward: ${name}`);
      // Runner-owned names — a spec must never unpin the egress sink or repoint the twin.
      if (/^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|LINEAR_API_URL)$/i.test(name)) {
        throw new Error(`env name is reserved by the scenario runner: ${name}`);
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`env.${name} must be a scalar in ${path}`);
      }
      env[name] = String(value);
    }
  }

  const rawSteps = doc.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`steps must be a non-empty array in ${path}`);
  }
  const seen = new Set<string>();
  const steps: ScenarioStep[] = rawSteps.map((rawStep, i) => {
    const label = `steps[${i}]`;
    const s = rawStep as Record<string, unknown> | null;
    if (!s || typeof s !== "object") throw new Error(`${label} must be an object`);
    if (typeof s.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(s.name)) {
      throw new Error(`${label}.name must match [a-z0-9][a-z0-9-]{0,63}: ${String(s.name)}`);
    }
    if (seen.has(s.name)) throw new Error(`duplicate step name: ${s.name}`);
    seen.add(s.name);
    if (typeof s.run !== "string" || s.run.trim() === "") throw new Error(`${label}.run missing`);
    let timeout: number | undefined;
    if (s.timeout_ms !== undefined) {
      timeout = Number(s.timeout_ms);
      if (!Number.isInteger(timeout) || timeout <= 0) throw new Error(`${label}.timeout_ms must be a positive integer`);
    }
    return { name: s.name, run: s.run.trim(), timeout_ms: timeout, expect: parseExpect(s.expect, label) };
  });

  return {
    scenario_id: id,
    description: typeof doc.description === "string" ? doc.description.trim() : undefined,
    seed,
    twin,
    env,
    steps,
  };
}

// ─── CLI (validate only — writes nothing) ─────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!scenariosEnabled()) {
    // Exit before ANY read/write when the flag is off (byte-identity AC).
    process.exit(0);
  }
  const specIdx = args.indexOf("--spec");
  if (args[0] !== "validate" || specIdx < 0 || specIdx + 1 >= args.length) {
    console.error("usage: scenario-spec.ts validate --spec <yaml>   (requires SF009_SCENARIOS=1)");
    process.exit(2);
  }
  const spec = parseScenarioSpec(args[specIdx + 1]);
  const twinNote = spec.twin ? `twin=${spec.twin.kind}` : "no twin";
  console.log(`scenario ${spec.scenario_id}: ${spec.steps.length} step(s), seed=${spec.seed}, ${twinNote} — VALID`);
  process.exit(0);
}
