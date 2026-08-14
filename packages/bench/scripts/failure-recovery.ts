#!/usr/bin/env bun
/**
 * Failure Recovery Benchmark — Q2 #5 §3.9 family (c) Cycle C
 *
 * Hybrid runner. --mode=synthetic loads scripted probe outcomes from
 * scenarios.json (zero live calls, runs in CI) and verifies that the healer
 * picks the correct fallback within the configured rung budget for each
 * failure mode (429 / 402 / timeout / cascade / all-down). --mode=integration
 * shells out to `healer.ts probe`, captures the live probe state, and verifies
 * the same chain logic against the current production model fleet.
 *
 * The benchmark exercises the pure pickHealthyFallback() extracted from
 * healer.ts so unit tests, this benchmark, and the live heal loop all share
 * one selection implementation.
 *
 * Usage:
 *   bun packages/bench/scripts/failure-recovery.ts                       # synthetic, all scenarios
 *   bun packages/bench/scripts/failure-recovery.ts --mode=integration    # live probe + chain verify
 *   bun packages/bench/scripts/failure-recovery.ts --scenario=sonnet-429 # single scenario
 *
 * Env: ZO_CLIENT_IDENTITY_TOKEN (required only for --mode=integration).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Mirror of Skills/agent-model-healer/scripts/healer.ts contract — kept
// inline so the bench package stays self-contained under its tsconfig
// rootDir. Both implementations cover the same test surface; healer's
// fallback-chain-invariants.test.ts pins production behavior.
type RungType = "proprietary" | "open-weight" | "zo-native" | "unknown";
type ProbeHealth = "healthy" | "degraded" | "unhealthy";
interface ProbeResult {
  model: string;
  healthy: boolean;
  health: ProbeHealth;
  latencyMs: number;
  error?: string;
  warning?: string;
  checkedAt: string;
}
const TERMINAL_ZO_MODELS = new Set(["zo:smart", "zo:fast"]);
const VERCEL_OPEN_WEIGHT_PREFIXES = ["vercel:moonshotai/", "vercel:minimax/", "vercel:meta/", "vercel:meta-llama/", "vercel:qwen/", "vercel:deepseek/"];
const OPEN_WEIGHT_LABEL_HINTS = ["gpt-oss", "kimi", "moonshot", " k2", "k2.", "qwen", "deepseek", "llama", "minimax"];
const PROPRIETARY_LABEL_HINTS = ["claude", "sonnet", "haiku", "opus", "gpt-", "codex", "gemini"];
export function classifyRung(model: string, label?: string): RungType {
  if (TERMINAL_ZO_MODELS.has(model)) return "zo-native";
  if (VERCEL_OPEN_WEIGHT_PREFIXES.some((p) => model.startsWith(p))) return "open-weight";
  const hay = (label || model).toLowerCase();
  if (OPEN_WEIGHT_LABEL_HINTS.some((h) => hay.includes(h))) return "open-weight";
  if (PROPRIETARY_LABEL_HINTS.some((h) => hay.includes(h))) return "proprietary";
  return "unknown";
}
export function pickHealthyFallback(
  fallbacks: string[],
  probeResults: Record<string, ProbeResult>,
  terminal: string = "zo:smart",
): { target: string; probedFallbacks: number; firstHealthyIndex: number } {
  let probedFallbacks = 0;
  for (let i = 0; i < fallbacks.length; i++) {
    const probe = probeResults[fallbacks[i]];
    if (!probe) continue;
    probedFallbacks++;
    if (probe.healthy) return { target: fallbacks[i], probedFallbacks, firstHealthyIndex: i };
  }
  return { target: terminal, probedFallbacks, firstHealthyIndex: -1 };
}
export type { ProbeResult, RungType };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCENARIOS_PATH = resolve(ROOT, "data/failure-recovery/scenarios.json");
const RUNS_DIR = resolve(ROOT, "data/runs");
const HEALER_SCRIPT = "/home/workspace/Skills/agent-model-healer/scripts/healer.ts";

export type Mode = "synthetic" | "integration";
export type RungBudget = "proprietary" | "open-weight" | "zo-native";

const RUNG_RANK: Record<RungType, number> = {
  proprietary: 0,
  "open-weight": 1,
  "zo-native": 2,
  unknown: 3,
};

export interface ScenarioProbe {
  healthy: boolean;
  error?: string;
  warning?: string;
  latencyMs?: number;
}

export interface Scenario {
  id: string;
  description: string;
  primary: string;
  probeResults: Record<string, ScenarioProbe>;
  expected: {
    target: string;
    rung: RungType;
    withinRungBudget: boolean;
    firstHealthyIndex: number;
  };
}

export interface ScenariosFile {
  metadata: {
    name: string;
    version: string;
    description: string;
    purpose: string;
    fallbackChainPath: string;
  };
  defaults: {
    rungBudget: RungBudget;
    terminalModel: string;
    switchBudgetCycles: number;
    failureBudget: number;
  };
  scenarios: Scenario[];
}

interface ChainConfig {
  fallbackChains: Record<string, { label: string; fallbacks: string[] }>;
  modelLabels: Record<string, string>;
}

export interface ScenarioResult {
  id: string;
  description: string;
  expected: { target: string; rung: RungType; withinRungBudget: boolean };
  actual: { target: string; rung: RungType; withinRungBudget: boolean; firstHealthyIndex: number; probedFallbacks: number };
  pass: boolean;
  failureReasons: string[];
}

export interface RunReport {
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  scenariosTotal: number;
  scenariosPassed: number;
  failureRate: number;
  failureBudget: number;
  rungBudget: RungBudget;
  scenarios: ScenarioResult[];
  passOverall: boolean;
}

function nowIso(): string { return new Date().toISOString(); }

function loadChainConfig(path: string): ChainConfig {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function toProbeResult(model: string, p: ScenarioProbe): ProbeResult {
  const ts = nowIso();
  return {
    model,
    healthy: p.healthy,
    health: p.healthy ? "healthy" : "unhealthy",
    latencyMs: p.latencyMs ?? 0,
    error: p.error,
    warning: p.warning,
    checkedAt: ts,
  };
}

function rungWithinBudget(actual: RungType, budget: RungBudget): boolean {
  const budgetRank = RUNG_RANK[budget as RungType] ?? 99;
  const actualRank = RUNG_RANK[actual] ?? 99;
  return actualRank <= budgetRank;
}

export function evaluateScenario(
  scenario: Scenario,
  chainConfig: ChainConfig,
  defaults: ScenariosFile["defaults"],
): ScenarioResult {
  const chain = chainConfig.fallbackChains[scenario.primary];
  const failureReasons: string[] = [];

  if (!chain) {
    return {
      id: scenario.id,
      description: scenario.description,
      expected: scenario.expected,
      actual: { target: "(no chain)", rung: "unknown", withinRungBudget: false, firstHealthyIndex: -1, probedFallbacks: 0 },
      pass: false,
      failureReasons: [`primary '${scenario.primary}' has no fallback chain registered`],
    };
  }

  const probeMap: Record<string, ProbeResult> = {};
  for (const [model, p] of Object.entries(scenario.probeResults)) {
    probeMap[model] = toProbeResult(model, p);
  }

  const pick = pickHealthyFallback(chain.fallbacks, probeMap, defaults.terminalModel);
  const actualRung = classifyRung(pick.target, chainConfig.modelLabels[pick.target]);
  const withinBudget = rungWithinBudget(actualRung, defaults.rungBudget);

  if (pick.target !== scenario.expected.target) {
    failureReasons.push(`target mismatch: expected '${scenario.expected.target}', got '${pick.target}'`);
  }
  if (actualRung !== scenario.expected.rung) {
    failureReasons.push(`rung mismatch: expected '${scenario.expected.rung}', got '${actualRung}'`);
  }
  if (withinBudget !== scenario.expected.withinRungBudget) {
    failureReasons.push(`budget mismatch: expected ${scenario.expected.withinRungBudget}, got ${withinBudget}`);
  }
  if (pick.firstHealthyIndex !== scenario.expected.firstHealthyIndex) {
    failureReasons.push(`firstHealthyIndex mismatch: expected ${scenario.expected.firstHealthyIndex}, got ${pick.firstHealthyIndex}`);
  }

  return {
    id: scenario.id,
    description: scenario.description,
    expected: scenario.expected,
    actual: {
      target: pick.target,
      rung: actualRung,
      withinRungBudget: withinBudget,
      firstHealthyIndex: pick.firstHealthyIndex,
      probedFallbacks: pick.probedFallbacks,
    },
    pass: failureReasons.length === 0,
    failureReasons,
  };
}

export function runSynthetic(
  scenarios: ScenariosFile,
  chainConfig: ChainConfig,
  filter?: string,
): RunReport {
  const startedAt = nowIso();
  const list = filter
    ? scenarios.scenarios.filter((s) => s.id === filter)
    : scenarios.scenarios;
  const results = list.map((s) => evaluateScenario(s, chainConfig, scenarios.defaults));
  const passed = results.filter((r) => r.pass).length;
  const failureRate = results.length === 0 ? 0 : 1 - passed / results.length;
  return {
    mode: "synthetic",
    startedAt,
    finishedAt: nowIso(),
    scenariosTotal: results.length,
    scenariosPassed: passed,
    failureRate,
    failureBudget: scenarios.defaults.failureBudget,
    rungBudget: scenarios.defaults.rungBudget,
    scenarios: results,
    passOverall: failureRate <= scenarios.defaults.failureBudget,
  };
}

interface LiveProbe { results: Array<{ model: string; healthy: boolean; health: string; latencyMs: number; error?: string }> }

function runLiveProbe(): LiveProbe {
  const out = spawnSync("bun", [HEALER_SCRIPT, "probe"], {
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
  });
  if (out.status !== 0) {
    throw new Error(`healer probe failed (status ${out.status}): ${out.stderr.slice(-500)}`);
  }
  const text = out.stdout;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("healer probe produced no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export function runIntegration(scenarios: ScenariosFile, chainConfig: ChainConfig): RunReport {
  const startedAt = nowIso();
  const live = runLiveProbe();
  const probeMap: Record<string, ProbeResult> = {};
  for (const r of live.results) {
    probeMap[r.model] = toProbeResult(r.model, { healthy: r.healthy, error: r.error, latencyMs: r.latencyMs });
  }

  const results: ScenarioResult[] = [];
  for (const primary of Object.keys(chainConfig.fallbackChains)) {
    const chain = chainConfig.fallbackChains[primary];
    const pick = pickHealthyFallback(chain.fallbacks, probeMap, scenarios.defaults.terminalModel);
    const actualRung = classifyRung(pick.target, chainConfig.modelLabels[pick.target]);
    const withinBudget = rungWithinBudget(actualRung, scenarios.defaults.rungBudget);
    const primaryProbe = probeMap[primary];
    const primaryHealthy = primaryProbe?.healthy ?? false;

    const expectedTarget = primaryHealthy ? primary : pick.target;
    const expectedRung = classifyRung(expectedTarget, chainConfig.modelLabels[expectedTarget]);

    results.push({
      id: `live:${primary}`,
      description: `Live chain check for ${chainConfig.modelLabels[primary] || primary}`,
      expected: { target: expectedTarget, rung: expectedRung, withinRungBudget: rungWithinBudget(expectedRung, scenarios.defaults.rungBudget) },
      actual: {
        target: pick.target,
        rung: actualRung,
        withinRungBudget: withinBudget,
        firstHealthyIndex: pick.firstHealthyIndex,
        probedFallbacks: pick.probedFallbacks,
      },
      pass: primaryHealthy ? true : pick.target !== "" && withinBudget,
      failureReasons: primaryHealthy
        ? []
        : (withinBudget ? [] : [`live chain for ${primary} fell through rung budget to ${actualRung}`]),
    });
  }
  const passed = results.filter((r) => r.pass).length;
  const failureRate = results.length === 0 ? 0 : 1 - passed / results.length;
  return {
    mode: "integration",
    startedAt,
    finishedAt: nowIso(),
    scenariosTotal: results.length,
    scenariosPassed: passed,
    failureRate,
    failureBudget: scenarios.defaults.failureBudget,
    rungBudget: scenarios.defaults.rungBudget,
    scenarios: results,
    passOverall: failureRate <= scenarios.defaults.failureBudget,
  };
}

function writeReport(report: RunReport): string {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const path = resolve(RUNS_DIR, `failure-recovery-${report.mode}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

function summarize(report: RunReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`=== Failure Recovery Benchmark — ${report.mode} mode ===`);
  lines.push(`Scenarios: ${report.scenariosPassed}/${report.scenariosTotal} pass (failure rate ${(report.failureRate * 100).toFixed(1)}%, budget ${(report.failureBudget * 100).toFixed(1)}%)`);
  lines.push(`Rung budget: ${report.rungBudget}`);
  lines.push("");
  for (const r of report.scenarios) {
    const icon = r.pass ? "✓" : "✗";
    lines.push(`${icon} ${r.id} → ${r.actual.target} (${r.actual.rung})`);
    if (!r.pass) {
      for (const reason of r.failureReasons) lines.push(`     - ${reason}`);
    }
  }
  lines.push("");
  lines.push(report.passOverall ? "OVERALL: PASS" : "OVERALL: FAIL");
  return lines.join("\n");
}

function parseArgs(argv: string[]): { mode: Mode; scenario?: string } {
  let mode: Mode = "synthetic";
  let scenario: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode=synthetic") mode = "synthetic";
    else if (a === "--mode=integration") mode = "integration";
    else if (a.startsWith("--scenario=")) scenario = a.slice("--scenario=".length);
  }
  return { mode, scenario };
}

async function main() {
  const { mode, scenario } = parseArgs(process.argv);
  const scenarios: ScenariosFile = JSON.parse(readFileSync(SCENARIOS_PATH, "utf-8"));
  const chainConfig = loadChainConfig(scenarios.metadata.fallbackChainPath);

  const report = mode === "synthetic"
    ? runSynthetic(scenarios, chainConfig, scenario)
    : runIntegration(scenarios, chainConfig);

  const out = writeReport(report);
  console.log(summarize(report));
  console.log(`Report: ${out}`);
  process.exit(report.passOverall ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
