#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-010 T0 — Evidence-Gated Auto-Merge Lane (L4 → L5 crossing)
 *
 * The core engine. After post-flight eval passes, the operator-opt-in
 * auto-merge lane runs the following blocking gates in order:
 *
 *   1. FLAG CHECK — SF010_AUTOMERGE must be "1". If off, returns "disabled".
 *   2. CIRCUIT BREAKER — if state/sf010-circuit-open.sentinel exists, refuses.
 *   3. ARCHETYPE ALLOWLIST — archetype must be on the allowlist.
 *   4. BASELINE CHECK — SF-002 agreement baseline ≥ 20 resolved decisions.
 *   5. SLO GATE — SF-005 yield_floor must not be in unreviewed breach.
 *   6. SCENARIO GATE — run each scenario spec 3× in SF-009; require ≥90% pass.
 *   7. SNAKE PIT — red-team adversarial cases; require 0 critical failures.
 *   8. CONSENSUS ATTESTATION — three distinct reviewers + arbiter unanimously
 *      accepted the implementation commit, with no later code changes.
 *
 * If all gates pass: calls FnMerger (real: gh pr merge --squash), writes the
 * immutable audit record, spawns the canary watcher, and returns "merged".
 *
 * If any gate fails: writes an operator-queue record, returns "operator".
 *
 * Advisory posture (SF010_AUTOMERGE=0, the default):
 *  - The gate still EVALUATES all checks and logs the would-be decision.
 *  - The audit record is written with merge_result.method="dry-run".
 *  - Nothing is merged. This lets operators build the 20-decision baseline
 *    without ever risking an unintended merge.
 *
 * All injectable — no real gh/git/SLO calls in tests.
 *
 * CLI (requires SF010_AUTOMERGE=1 for live merge; 0 = advisory only):
 *   bun auto-merge-lane.ts evaluate --pr <ref> --archetype <type> \
 *     [--ticket <ZOU-N — the ticket the attestation certifies; defaults to the PR ref>] \
 *     [--attestation <consensus-attestation.json>] [--repo-dir <git-checkout>] \
 *     [--merge-repo <owner/repo>] [--no-watcher] \
 *     [--scenario <spec.yaml>...] [--diff <file>] [--json]
 *   bun auto-merge-lane.ts status [--json]
 *
 * Live-mode wiring: --attestation/--repo-dir feed Gates 6+8 (without them the
 * lane fails closed to the operator queue); with SF010_AUTOMERGE=1 the merger
 * is the real `gh pr merge --squash` against --merge-repo (default
 * marlandoj/zouroboros) and a detached canary watcher (auto-rollback.ts watch)
 * is spawned after a confirmed merge.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { agreementStats, calibrationGate, readLedger, type CalibrationGateResult } from "./approval-ledger";
import {
  checkArchetypeAllowlist,
  getAllowedArchetypes,
} from "./archetype-allowlist";
import { checkCircuit } from "./auto-rollback";
import { defaultSloSources, laneBlockDecision, readSloStateFile } from "./factory-slo";
import {
  type AutoMergeAudit,
  type MergeResult,
  writeAuditRecord,
} from "./merge-audit-trail";
import type { RiskVerdict } from "./risk-classifier";
import type { ScenarioRunRecord } from "./scenario-run";
import { runScenario, scenarioSpecSha256 } from "./scenario-run";
import { catalogManifestSha256, scenariosForArchetype } from "./scenario-catalog";
import { runSnakePit, type SnakePitReport } from "./snake-pit";
import { verifyConsensusAttestation } from "./consensus-attestation";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AutoMergeLaneConfig {
  /** Minimum scenario pass rate (default 0.9 = 90%). */
  min_scenario_pass_rate: number;
  /** Number of runs per scenario spec (default 3). */
  scenario_runs: number;
  /** Minimum resolved SF-002 decisions before the auto-lane can act (default 20). */
  min_baseline_decisions: number;
}

export const DEFAULT_LANE_CONFIG: AutoMergeLaneConfig = {
  min_scenario_pass_rate: 0.9,
  scenario_runs: 3,
  min_baseline_decisions: 20,
};

export interface LaneGateResult {
  gate: string;
  passed: boolean;
  reason: string;
}

export type AutoMergeDecision = "merged" | "operator" | "disabled" | "advisory";

export interface AutoMergeLaneResult {
  decision: AutoMergeDecision;
  pr_ref: string;
  archetype: string;
  gates: LaneGateResult[];
  reason: string;
  audit_path?: string;
  audit_error?: string;
  merge_result?: MergeResult;
  merge_ts?: string;
  advisory_only: boolean;
}

/** Injectable merger — real: gh pr merge --squash --auto */
export type FnMerger = (prRef: string) => Promise<MergeResult>;

/** Injectable scenario runner — real: runScenario(specPath) */
export type FnScenarioRunner = (specPath: string) => Promise<ScenarioRunRecord>;

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function operatorQueuePath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "operator-queue.jsonl");
}

function appendOperatorQueue(entry: object, base = PROJECT_DIR): void {
  const path = operatorQueuePath(base);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// ─── Flag ────────────────────────────────────────────────────────────────────

export function automergeEnabled(): boolean {
  return process.env.SF010_AUTOMERGE === "1";
}

// ─── Scenario gate (3× per spec, ≥90% pass) ──────────────────────────────────

export async function runScenariosGate(
  specPaths: string[],
  runner: FnScenarioRunner,
  config: AutoMergeLaneConfig,
  binding: { evaluatedCommit?: string | null; manifestSha256?: string | null } = {},
): Promise<{ gate: LaneGateResult; records: ScenarioRunRecord[] }> {
  if (specPaths.length === 0) {
    return {
      gate: { gate: "scenario_runner", passed: true, reason: "no scenario specs provided — gate skipped" },
      records: [],
    };
  }

  const records: ScenarioRunRecord[] = [];
  let totalRuns = 0;
  let totalPassed = 0;
  const failures: string[] = [];

  const previousCommit = process.env.SF009_EVALUATED_COMMIT;
  const previousManifest = process.env.SF009_SCENARIO_MANIFEST_SHA256;

  try {
    if (binding.evaluatedCommit) process.env.SF009_EVALUATED_COMMIT = binding.evaluatedCommit;
    else delete process.env.SF009_EVALUATED_COMMIT;
    if (binding.manifestSha256) process.env.SF009_SCENARIO_MANIFEST_SHA256 = binding.manifestSha256;
    else delete process.env.SF009_SCENARIO_MANIFEST_SHA256;

    for (const specPath of specPaths) {
      for (let run = 0; run < config.scenario_runs; run++) {
        try {
          const record = await runner(specPath);
          records.push(record);
          totalRuns++;
          const bindingFailures = [
            ...(binding.evaluatedCommit && record.evaluated_commit !== binding.evaluatedCommit
              ? [`evaluated commit ${record.evaluated_commit ?? "missing"} !== ${binding.evaluatedCommit}`]
              : []),
            ...(binding.manifestSha256 && record.scenario_manifest_sha256 !== binding.manifestSha256
              ? [`manifest ${record.scenario_manifest_sha256 ?? "missing"} !== ${binding.manifestSha256}`]
              : []),
            ...(binding.manifestSha256 && record.scenario_spec_sha256 !== scenarioSpecSha256(specPath)
              ? ["scenario spec hash does not match the committed spec"]
              : []),
          ];
          if (record.verdict === "passed" && bindingFailures.length === 0) {
            totalPassed++;
          } else {
            failures.push(`${specPath} run ${run + 1}: ${[...record.failures, ...bindingFailures].join("; ") || "binding failed"}`);
          }
        } catch (err) {
          totalRuns++;
          failures.push(`${specPath} run ${run + 1}: runner threw ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } finally {
    if (previousCommit === undefined) delete process.env.SF009_EVALUATED_COMMIT;
    else process.env.SF009_EVALUATED_COMMIT = previousCommit;
    if (previousManifest === undefined) delete process.env.SF009_SCENARIO_MANIFEST_SHA256;
    else process.env.SF009_SCENARIO_MANIFEST_SHA256 = previousManifest;
  }

  const passRate = totalRuns > 0 ? totalPassed / totalRuns : 0;
  const passed = passRate >= config.min_scenario_pass_rate;

  return {
    gate: {
      gate: "scenario_runner",
      passed,
      reason: passed
        ? `${totalPassed}/${totalRuns} runs passed (${(passRate * 100).toFixed(1)}% ≥ ${config.min_scenario_pass_rate * 100}%)`
        : `${totalPassed}/${totalRuns} runs passed (${(passRate * 100).toFixed(1)}% < ${config.min_scenario_pass_rate * 100}%); failures: ${failures.slice(0, 3).join(" | ")}`,
    },
    records,
  };
}

// ─── Core lane evaluation (all injectable) ───────────────────────────────────

export async function runAutoMergeLane(
  prRef: string,
  archetype: string,
  riskVerdict: RiskVerdict,
  scenarioSpecPaths: string[],
  diff: string,
  deps: {
    merger?: FnMerger;
    scenarioRunner?: FnScenarioRunner;
    base?: string;
    config?: Partial<AutoMergeLaneConfig>;
    consensusAttestationPath?: string;
    consensusRepoDir?: string;
    consensusLedgerPath?: string;
    consensusKeyPath?: string;
    auditWriter?: typeof writeAuditRecord;
  } = {},
): Promise<AutoMergeLaneResult> {
  const base = deps.base ?? PROJECT_DIR;
  const cfg = { ...DEFAULT_LANE_CONFIG, ...(deps.config ?? {}) };
  const advisory = !automergeEnabled();
  const gates: LaneGateResult[] = [];

  // ── Gate 1: Flag check ────────────────────────────────────────────────────
  gates.push({
    gate: "flag_sf010",
    passed: true,  // we continue in advisory mode even when flag is off
    reason: advisory ? "SF010_AUTOMERGE=0 — advisory mode (dry-run)" : "SF010_AUTOMERGE=1 — live merge enabled",
  });

  // ── Gate 2: Circuit breaker ───────────────────────────────────────────────
  const circuit = checkCircuit(base);
  const circuitGate: LaneGateResult = {
    gate: "circuit_breaker",
    passed: !circuit.tripped,
    reason: circuit.tripped
      ? `circuit open — ${circuit.consecutive} consecutive auto-rollbacks; reset required`
      : `circuit closed (${circuit.consecutive} consecutive rollbacks)`,
  };
  gates.push(circuitGate);
  if (circuit.tripped && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, "circuit breaker open", advisory, base);
  }

  // ── Gate 3: Archetype allowlist ───────────────────────────────────────────
  const allowed = getAllowedArchetypes(factoryStatePathForProject(base, "archetype-allowlist.json"));
  const archetypeDecision = checkArchetypeAllowlist(archetype, allowed);
  const archetypeGate: LaneGateResult = {
    gate: "archetype_allowlist",
    passed: archetypeDecision.allowed,
    reason: archetypeDecision.reason,
  };
  gates.push(archetypeGate);
  if (!archetypeDecision.allowed && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, archetypeDecision.reason, advisory, base);
  }

  // ── Gate 4: SF-002 baseline + calibration (ZOU-1110) ──────────────────────
  // Count-only eligibility is forbidden: the deduped ticket+action sample must
  // meet the minimum AND the confusion matrix must show 0 false approvals and a
  // false-hold rate within tolerance. Ledger read failure fails closed.
  let resolvedDecisions = 0;
  let calib: CalibrationGateResult | null = null;
  const baselineDisabled = cfg.min_baseline_decisions <= 0;
  if (!baselineDisabled) {
    try {
      // base-scoped: the lane must read the ledger belonging to the state tree
      // it evaluates (and selftests must never depend on live state).
      const ledger = readLedger(factoryStatePathForProject(base, "approval-ledger.jsonl"));
      const stats = agreementStats(ledger);
      resolvedDecisions = stats.resolved;  // operator-responded only — pending entries don't count
      calib = calibrationGate(stats.calibration, cfg.min_baseline_decisions);
    } catch { /* read failure = no calibration = blocked */ }
  }
  const countOk = resolvedDecisions >= cfg.min_baseline_decisions;
  const baselinePassed = baselineDisabled || (countOk && calib !== null && calib.eligible);
  const baselineGate: LaneGateResult = {
    gate: "sf002_baseline",
    passed: baselinePassed,
    reason: baselineDisabled
      ? "baseline gate disabled by config (min_baseline_decisions=0)"
      : baselinePassed && calib
      ? `baseline met: ${resolvedDecisions} resolved rows, ${calib.matrix.deduped_decisions} calibrated ticket+action decisions ≥ ${cfg.min_baseline_decisions}, 0 false approvals, false-hold ${calib.matrix.false_hold_rate !== null ? (calib.matrix.false_hold_rate * 100).toFixed(1) + "%" : "n/a"} within tolerance`
      : !countOk
        ? `baseline not met: ${resolvedDecisions}/${cfg.min_baseline_decisions} resolved decisions — build the baseline before enabling auto-merge`
        : calib === null
          ? "calibration unavailable (ledger read failure) — fail closed"
          : `calibration gate failed: ${calib.reasons.join("; ")}`,
  };
  gates.push(baselineGate);
  if (!baselineGate.passed && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, baselineGate.reason, advisory, base);
  }

  // ── Gate 5: SF-005 SLO ────────────────────────────────────────────────────
  const sloSrc = defaultSloSources();
  const sloState = readSloStateFile(sloSrc.statePath);
  const sloBlock = laneBlockDecision(sloState);
  const sloGate: LaneGateResult = {
    gate: "slo_yield_floor",
    passed: !sloBlock.blocked,
    reason: sloBlock.reason,
  };
  gates.push(sloGate);
  if (sloBlock.blocked && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, sloBlock.reason, advisory, base);
  }

  // ── Gate 6: Scenario runner (3× per spec, ≥90%) ──────────────────────────
  const productionRunner = deps.scenarioRunner === undefined;
  const runner: FnScenarioRunner = deps.scenarioRunner ?? (async (specPath) => runScenario(specPath));
  const catalogEntries = scenariosForArchetype(archetype);
  const effectiveScenarioPaths = scenarioSpecPaths.length > 0
    ? scenarioSpecPaths
    : catalogEntries.map((entry) => entry.path);
  const manifestEntries = scenarioSpecPaths.length > 0
    ? scenarioSpecPaths.map((path) => ({ id: path, path, coverage: [] as readonly string[] }))
    : catalogEntries;
  const scenarioManifestSha256 = productionRunner && manifestEntries.length > 0
    ? catalogManifestSha256(manifestEntries)
    : null;
  const evaluatedCommit = productionRunner ? readAttestedImplementationCommit(deps.consensusAttestationPath) : null;
  const missingProductionBinding = productionRunner && !advisory && (
    !evaluatedCommit || !scenarioManifestSha256 || process.env.SF009_SCENARIOS !== "1"
  );
  const { gate: scenGate, records: scenRecords } = await runScenariosGate(
    effectiveScenarioPaths,
    runner,
    cfg,
    { evaluatedCommit, manifestSha256: scenarioManifestSha256 },
  );
  if (missingProductionBinding) {
    scenGate.passed = false;
    scenGate.reason = process.env.SF009_SCENARIOS !== "1"
      ? "scenario gate requires SF009_SCENARIOS=1"
      : !evaluatedCommit
      ? "scenario gate requires a verified consensus implementation commit"
      : "scenario gate requires a non-empty committed scenario catalog";
  }
  gates.push(scenGate);
  if (!scenGate.passed && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, scenGate.reason, advisory, base);
  }

  // ── Gate 7: Snake Pit ─────────────────────────────────────────────────────
  const pitReport = await runSnakePit(prRef, diff, runner, { seed: riskVerdict.score * 1e6 });
  const pitGate: LaneGateResult = {
    gate: "snake_pit",
    passed: pitReport.verdict === "pass",
    reason: pitReport.verdict === "pass"
      ? `snake pit: ${pitReport.cases_passed}/${pitReport.cases_generated} passed, 0 critical failures`
      : `snake pit: ${pitReport.critical_failures.length} critical failure(s): ${pitReport.critical_failures.map((f) => f.description).join("; ")}`,
  };
  gates.push(pitGate);
  if (pitReport.verdict !== "pass" && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, pitGate.reason, advisory, base, {
      snake_pit: pitReport,
      slo: sloState,
      scenarios: scenRecords,
    });
  }

  // ── Gate 8: mandatory consensus attestation ────────────────────────────────
  const consensus = verifyConsensusAttestation(
    deps.consensusAttestationPath,
    riskVerdict.identifier,
    deps.consensusRepoDir,
    deps.consensusLedgerPath,
    deps.consensusKeyPath,
  );
  const consensusGate: LaneGateResult = {
    gate: "consensus_attestation",
    passed: consensus.passed,
    reason: consensus.reason,
  };
  gates.push(consensusGate);
  if (!consensus.passed) {
    return buildOperatorResult(prRef, archetype, gates, consensus.reason, advisory, base, {
      snake_pit: pitReport,
      slo: sloState,
      scenarios: scenRecords,
    });
  }

  // ── All gates passed — decide action ─────────────────────────────────────
  const allPassed = gates.every((g) => g.passed);
  const ts = new Date().toISOString();
  const merger: FnMerger = deps.merger ?? noopMerger;

  let mergeResult: MergeResult;
  if (advisory || !allPassed) {
    mergeResult = {
      sha: null,
      method: "dry-run",
      duration_ms: 0,
    };
  } else {
    const mergeStart = Date.now();
    try {
      mergeResult = await merger(prRef);
      mergeResult.duration_ms = Date.now() - mergeStart;
    } catch (err) {
      mergeResult = {
        sha: null,
        method: "error",
        duration_ms: Date.now() - mergeStart,
        error: err instanceof Error ? err.message : String(err),
      };
      return buildOperatorResult(prRef, archetype, gates, `merger threw: ${mergeResult.error}`, advisory, base);
    }
  }

  // Write immutable audit record
  const audit: AutoMergeAudit = {
    schema_version: 1,
    pr_ref: prRef,
    archetype,
    ts,
    risk_verdict: riskVerdict,
    scenario_results: scenRecords,
    snake_pit_report: pitReport,
    slo_snapshot: sloState === "corrupt" ? null : sloState,
    ...(consensus.attestation && consensus.path ? {
      consensus_attestation: {
        path: consensus.path,
        ticket: consensus.attestation.ticket,
        gate_id: consensus.attestation.gate_id,
        repository_remote: consensus.attestation.repository_remote,
        base_commit: consensus.attestation.base_commit,
        implementation_commit: consensus.attestation.implementation_commit,
        implementation_diff_sha256: consensus.attestation.implementation_diff_sha256,
        gate_evidence_hmac: consensus.attestation.gate_evidence_hmac,
      },
    } : {}),
    merge_result: mergeResult,
  };

  let auditPath: string | undefined;
  let auditError: string | undefined;
  try {
    auditPath = (deps.auditWriter ?? writeAuditRecord)(audit, base);
  } catch (error) {
    auditError = error instanceof Error ? error.message : String(error);
  }

  const decision: AutoMergeDecision = advisory ? "advisory" : "merged";
  return {
    decision,
    pr_ref: prRef,
    archetype,
    gates,
    reason: advisory
      ? `advisory mode — all ${gates.length} gates ${allPassed ? "passed" : "had failures"}; no merge executed${auditError ? `; audit persistence failed: ${auditError}` : ""}`
      : auditError
        ? `all gates passed — PR#${prRef} auto-merged (sha: ${mergeResult.sha ?? "n/a"}); audit persistence failed: ${auditError}`
        : `all gates passed — PR#${prRef} auto-merged (sha: ${mergeResult.sha ?? "n/a"})`,
    audit_path: auditPath,
    ...(auditError ? { audit_error: auditError } : {}),
    merge_result: mergeResult,
    merge_ts: ts,
    advisory_only: advisory,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildOperatorResult(
  prRef: string,
  archetype: string,
  gates: LaneGateResult[],
  reason: string,
  advisory: boolean,
  base: string,
  extras?: { snake_pit?: SnakePitReport; slo?: unknown; scenarios?: ScenarioRunRecord[] },
): AutoMergeLaneResult {
  const entry = {
    pr_ref: prRef,
    archetype,
    ts: new Date().toISOString(),
    reason,
    gates,
    ...extras,
  };
  appendOperatorQueue(entry, base);
  return {
    decision: advisory ? "advisory" : "operator",
    pr_ref: prRef,
    archetype,
    gates,
    reason,
    advisory_only: advisory,
  };
}

const noopPassRunner: FnScenarioRunner = async (_specPath) => ({
  scenario_id: "noop",
  seed: 0,
  verdict: "passed" as const,
  steps_total: 1,
  steps_passed: 1,
  failed_step: null,
  failures: [],
  twin: null,
  twin_requests: 0,
  twin_transcript_sha256: null,
  scenario_spec_sha256: "",
  scenario_manifest_sha256: null,
  evaluated_commit: null,
  duration_ms: 0,
  ts: new Date().toISOString(),
});

function readAttestedImplementationCommit(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { implementation_commit?: unknown };
    return typeof value.implementation_commit === "string" && /^[a-f0-9]{40,64}$/i.test(value.implementation_commit)
      ? value.implementation_commit
      : null;
  } catch {
    return null;
  }
}

const noopMerger: FnMerger = async (prRef) => ({
  sha: `noop-sha-${prRef}`,
  method: "squash",
  duration_ms: 0,
});

/** Injectable gh invocation — real: spawnSync("gh", args). */
export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultGhRunner: GhRunner = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Real merger for live canary runs: gh pr merge --squash, then confirm the
 * merge state and resolve the real squash sha. Any failure throws, which the
 * lane converts into a fail-closed operator-queue routing.
 */
export function realGhMerger(mergeRepo: string, gh: GhRunner = defaultGhRunner): FnMerger {
  return async (prRef) => {
    const merge = gh(["pr", "merge", prRef, "--squash", "--repo", mergeRepo]);
    if (merge.status !== 0) {
      throw new Error(`gh pr merge failed: ${(merge.stderr || merge.stdout || "unknown error").trim()}`);
    }
    const view = gh(["pr", "view", prRef, "--repo", mergeRepo, "--json", "state,mergeCommit"]);
    if (view.status !== 0) {
      throw new Error(`gh pr view failed after merge: ${(view.stderr || "unknown error").trim()}`);
    }
    const parsed = JSON.parse(view.stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
    const sha = parsed.mergeCommit?.oid ?? null;
    if (parsed.state !== "MERGED" || !sha || !/^[a-f0-9]{40}$/i.test(sha)) {
      throw new Error(`merge not confirmed: state=${parsed.state ?? "unknown"} sha=${sha ?? "null"}`);
    }
    return { sha, method: "squash", duration_ms: 0 };
  };
}

export function spawnCanaryWatcher(prRef: string, mergeSha: string, mergeTs: string, base = PROJECT_DIR): { pid: number | undefined; log: string } {
  const canaryDir = factoryStatePathForProject(base, "canary");
  mkdirSync(canaryDir, { recursive: true });
  const log = join(canaryDir, `watch-${prRef.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.log`);
  const out = openSync(log, "a");
  const child = spawn(
    "bun",
    [join(import.meta.dir, "auto-rollback.ts"), "watch", "--pr", prRef, "--sha", mergeSha, "--ts", mergeTs, "--json"],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  return { pid: child.pid, log };
}

export type FnCanaryWatcherSpawner = typeof spawnCanaryWatcher;

export function startCanaryWatcherForResult(
  result: AutoMergeLaneResult,
  base = PROJECT_DIR,
  spawner: FnCanaryWatcherSpawner = spawnCanaryWatcher,
): { started: boolean; reason: string; pid?: number; log?: string } {
  if (result.decision !== "merged") {
    return { started: false, reason: `decision=${result.decision}; watcher not required` };
  }
  const mergeSha = result.merge_result?.sha ?? null;
  const mergeTs = result.merge_ts ?? null;
  if (!mergeSha || !mergeTs) {
    return { started: false, reason: "confirmed merge sha or timestamp missing" };
  }
  const watcher = spawner(result.pr_ref, mergeSha, mergeTs, base);
  return {
    started: true,
    reason: result.audit_error
      ? `watcher started from confirmed merge result despite audit error: ${result.audit_error}`
      : "watcher started from confirmed merge result",
    ...(watcher.pid !== undefined ? { pid: watcher.pid } : {}),
    log: watcher.log,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      archetype: { type: "string" },
      scenario: { type: "string", multiple: true },
      diff: { type: "string" },
      json: { type: "boolean" },
      attestation: { type: "string" },
      ticket: { type: "string" },
      "repo-dir": { type: "string" },
      "merge-repo": { type: "string" },
      "no-watcher": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const [cmd] = positionals;

  if (cmd === "evaluate") {
    const prRef = values.pr;
    const archetype = values.archetype ?? "doc_fix";
    if (!prRef) { console.error("--pr <ref> required"); process.exit(1); }

    const diff = values.diff
      ? readFileSync(String(values.diff), "utf-8")
      : "";

    // --ticket binds Gate 8 to the ticket the attestation certifies; the PR ref
    // is NOT a ticket id, and the attestation verifier rejects the mismatch.
    const ticketIdentifier = values.ticket ? String(values.ticket) : String(prRef);
    const mockVerdict: RiskVerdict = {
      verdict_id: `cli-${Date.now()}`,
      execution_id: "cli",
      ticket_id: ticketIdentifier,
      identifier: ticketIdentifier,
      tier: "low",
      score: 0.1,
      reasons: ["CLI evaluation"],
      inputs: {
        archetype: String(archetype),
        target_repo: "cli",
        repro: "",
        acceptance_criteria: "",
        gate_decision: "DIRECT",
        seed_eval_score: null,
        files_touched_estimate: 1,
        schema_contact: false,
        secret_contact: false,
        infra_contact: false,
        reversibility: "easy",
      },
      classified_at: new Date().toISOString(),
      mode: "shadow",
      acted: false,
    };

    const attestationPath = values.attestation ? String(values.attestation) : undefined;
    const repoDir = values["repo-dir"] ? String(values["repo-dir"]) : (attestationPath ? PROJECT_DIR : undefined);
    const mergeRepo = String(values["merge-repo"] ?? "marlandoj/zouroboros");

    const result = await runAutoMergeLane(
      String(prRef),
      String(archetype),
      mockVerdict,
      (values.scenario as string[] | undefined) ?? [],
      diff,
      {
        ...(attestationPath ? { consensusAttestationPath: attestationPath, consensusRepoDir: repoDir } : {}),
        ...(automergeEnabled() ? { merger: realGhMerger(mergeRepo) } : {}),
      },
    );

    if (result.decision === "merged" && !values["no-watcher"]) {
      const watcher = startCanaryWatcherForResult(result);
      if (watcher.started) {
        console.error(`canary watcher spawned: pid=${watcher.pid ?? "unknown"} log=${watcher.log}`);
        if (result.audit_error) console.error(`WARNING: ${watcher.reason}`);
      } else {
        console.error(`WARNING: decision=merged but canary watcher was not spawned: ${watcher.reason}`);
      }
    }

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nAuto-Merge Lane: ${result.decision.toUpperCase()}`);
      console.log(`PR: ${result.pr_ref}  Archetype: ${result.archetype}`);
      for (const g of result.gates) {
        console.log(`  ${g.passed ? "✓" : "✗"} [${g.gate}] ${g.reason}`);
      }
      console.log(`\nOutcome: ${result.reason}`);
      if (result.audit_path) console.log(`Audit: ${result.audit_path}`);
    }
    process.exit(result.decision === "merged" || result.decision === "advisory" ? 0 : 1);

  } else if (cmd === "status") {
    const { listAuditRecords } = await import("./merge-audit-trail");
    const { consecutiveRollbacks } = await import("./merge-audit-trail");
    const records = listAuditRecords();
    const circuit = checkCircuit();
    const enabled = automergeEnabled();
    const info = {
      enabled,
      circuit_status: circuit,
      total_auto_merges: records.length,
      total_rollbacks: records.filter((r) => r.rollback).length,
      consecutive_rollbacks: consecutiveRollbacks(),
    };
    if (values.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`SF010_AUTOMERGE: ${enabled ? "ON" : "OFF"}`);
      console.log(`Circuit: ${circuit.tripped ? "OPEN" : "CLOSED"} (${circuit.consecutive} consecutive rollbacks)`);
      console.log(`Auto-merges: ${info.total_auto_merges} total, ${info.total_rollbacks} rolled back`);
    }
  } else {
    console.log("Usage: bun auto-merge-lane.ts <evaluate|status> [options]");
    process.exit(0);
  }
}
