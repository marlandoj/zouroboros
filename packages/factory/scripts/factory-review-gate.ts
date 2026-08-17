#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { factoryReviewEnvironment } from "./factory-review-topology";
import type { ExecutionPolicy } from "./model-policy";
import { modelReviewAuthorized, policyEnvironment } from "./model-policy";
import type { PersonaReviewGateResult } from "./persona-orchestrator";

export type FactoryReviewMode = "shadow" | "enforce";

export interface ReviewCheckResult {
  pass: boolean;
  summary: string;
}

export interface ConsensusReviewResult extends ReviewCheckResult {
  consensus_id: string | null;
  confidence: number | null;
}

/**
 * What already substantiated this implementation before the review gate ran.
 *
 * The deterministic review is `git diff --check` — a whitespace and
 * conflict-marker check, not a judgement about whether the code is correct. It
 * is deliberately proportional (ZOU-599): Routine work gets the cheap check
 * because the pipeline has *already* put every completed execution through the
 * factory consensus gate, and `swarm-exec` routes any non-passing consensus to
 * `held` before the review gate is reached.
 *
 * That invariant is what makes enforce mode safe. This field makes it explicit
 * rather than assumed, so that if the consensus gate is ever skipped — today
 * `SF_FACTORY_CONSENSUS=0` does exactly that — enforce fails closed instead of
 * promoting work that nothing substantive ever reviewed (Article IX).
 */
export interface PriorVerification {
  kind: "consensus" | "operator";
  status: string;
  reference: string | null;
}

export interface FactoryReviewInput {
  execution_id: string;
  identifier: string;
  implementation_summary: string;
  ticket_context: string;
  workdir: string;
  policy: ExecutionPolicy | null;
  risk_tier: string | null;
  state_dir?: string;
  prior_verification?: PriorVerification | null;
}

export interface FactoryReviewResult {
  version: 1;
  execution_id: string;
  identifier: string;
  mode: FactoryReviewMode;
  review_level: "deterministic" | "consensus";
  deterministic: ReviewCheckResult;
  consensus: ConsensusReviewResult | null;
  pass: boolean;
  blocking: boolean;
  substantiated: boolean;
  substantiation: string;
  advance_to_verified: boolean;
  reviewed_at: string;
  persona_reviews?: PersonaReviewGateResult;
}

export interface FactoryReviewDeps {
  deterministic?: (input: FactoryReviewInput) => Promise<ReviewCheckResult> | ReviewCheckResult;
  consensus?: (input: FactoryReviewInput) => Promise<ConsensusReviewResult>;
  now?: () => string;
  mode?: FactoryReviewMode;
  write_result?: boolean;
  model_review_authorized?: boolean;
  persona_review?: (deterministic: ReviewCheckResult) => Promise<PersonaReviewGateResult>;
}

const CONSENSUS_GATE = "/home/workspace/Skills/consensus-gate/scripts/consensus-gate.ts";

export function resolveReviewMode(env: Record<string, string | undefined> = process.env): FactoryReviewMode {
  const mode = env.FACTORY_REVIEW_GATE_MODE ?? "shadow";
  if (mode !== "shadow" && mode !== "enforce") throw new Error(`FACTORY_REVIEW_GATE_MODE must be shadow|enforce, got ${mode}`);
  return mode;
}

export function requiresConsensus(
  policy: ExecutionPolicy | null,
  riskTier: string | null,
  authorized = false,
): boolean {
  return authorized && (policy?.review_level === "consensus" || riskTier?.toLowerCase() === "high");
}

export function reviewArtifact(input: FactoryReviewInput): string {
  return [
    `Ticket: ${input.identifier}`,
    `Execution: ${input.execution_id}`,
    `Risk: ${input.risk_tier ?? "unknown"}`,
    `Policy: ${input.policy?.tier ?? "default"}/${input.policy?.review_level ?? "deterministic"}`,
    "",
    "Ticket context:",
    input.ticket_context.slice(0, 20_000),
    "",
    "Implementation evidence:",
    input.implementation_summary.slice(0, 40_000),
  ].join("\n");
}

export function defaultDeterministicReview(input: FactoryReviewInput): ReviewCheckResult {
  // Scope to the workdir subtree and skip submodules: recursing the meta-repo's
  // submodules while an executor is concurrently committing caused transient
  // `git ETIMEDOUT` (ZOU-619). 120s cap leaves margin for that lock/stat
  // contention; steady-state this check is sub-second.
  const check = spawnSync("git", ["diff", "--check", "--ignore-submodules=all", "--", "."], {
    cwd: input.workdir,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (check.error) return { pass: false, summary: check.error.message };
  return {
    pass: check.status === 0,
    summary: check.status === 0 ? "git diff --check passed" : (check.stderr || check.stdout || "git diff --check failed").trim(),
  };
}

export async function defaultConsensusReview(input: FactoryReviewInput): Promise<ConsensusReviewResult> {
  if (!existsSync(CONSENSUS_GATE)) return { pass: false, summary: "consensus gate missing", consensus_id: null, confidence: null };
  const run = spawnSync("bun", [
    CONSENSUS_GATE,
    "validate",
    "--code",
    reviewArtifact(input),
    "--criteria",
    "correctness,completeness,security,production-readiness",
    "--label",
    `factory-${input.identifier}-${input.execution_id}`,
    "--mode",
    "code-review",
    "--json",
  ], {
    cwd: input.workdir,
    encoding: "utf8",
    timeout: 15 * 60_000,
    env: factoryReviewEnvironment(
      process.env,
      {
        ...policyEnvironment(
          input.policy ?? { tier: "Routine", pin_proposers: [], pin_aggregator: null, model_chain: [], review_level: "deterministic" },
          { modelReviewAuthorized: true },
        ),
        ZO_TRACE_ID: `factory:${input.execution_id}`,
      },
    ),
  });
  if (run.error || run.status !== 0) {
    return {
      pass: false,
      summary: run.error?.message ?? (run.stderr.trim() || `consensus exit ${run.status}`),
      consensus_id: null,
      confidence: null,
    };
  }
  const marker = run.stdout.split("\n").find((line) => line.startsWith("__CG_JSON__"));
  if (!marker) return { pass: false, summary: "consensus result marker missing", consensus_id: null, confidence: null };
  const parsed = JSON.parse(marker.slice("__CG_JSON__".length)) as any;
  return {
    pass: parsed?.consensus?.pass === true,
    summary: `consensus ${parsed?.status ?? "unknown"}`,
    consensus_id: typeof parsed?.id === "string" ? parsed.id : null,
    confidence: typeof parsed?.consensus?.confidence === "number" ? parsed.consensus.confidence : null,
  };
}

/**
 * Decide whether anything beyond `git diff --check` vouched for this work.
 *
 * A consensus verdict in this run counts, and so does one the pipeline already
 * obtained — `swarm-exec` reuses its passed consensus rather than paying for a
 * second panel. An operator approval counts because a human is the
 * verification. Nothing else does.
 */
export function substantiate(
  consensus: ConsensusReviewResult | null,
  prior: PriorVerification | null,
  personaReviews: PersonaReviewGateResult | null = null,
): { substantiated: boolean; reason: string } {
  if (consensus?.pass === true) return { substantiated: true, reason: "consensus review passed" };
  if (personaReviews?.mode === "enforce" && personaReviews.required_count > 0 && personaReviews.pass) {
    return { substantiated: true, reason: `${personaReviews.required_count} required persona review(s) passed after deterministic review` };
  }
  if (prior?.status === "passed") {
    return {
      substantiated: true,
      reason: prior.kind === "operator"
        ? `operator approval by ${prior.reference ?? "unknown"}`
        : `prior consensus passed${prior.reference ? ` (${prior.reference})` : ""}`,
    };
  }
  if (consensus) return { substantiated: false, reason: `consensus review did not pass: ${consensus.summary}` };
  return {
    substantiated: false,
    reason: prior
      ? `prior verification is ${prior.status}, not passed`
      : "no consensus verdict and no prior verification — deterministic check alone cannot promote",
  };
}

function writeResult(path: string, result: FactoryReviewResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temp, path);
}

export async function runFactoryReviewGate(
  input: FactoryReviewInput,
  deps: FactoryReviewDeps = {},
): Promise<FactoryReviewResult> {
  const mode = deps.mode ?? resolveReviewMode();
  const deterministic = await (deps.deterministic ?? defaultDeterministicReview)(input);
  const personaReviews = deps.persona_review ? await deps.persona_review(deterministic) : null;
  const authorized = deps.model_review_authorized ?? modelReviewAuthorized();
  const reviewLevel = requiresConsensus(input.policy, input.risk_tier, authorized) ? "consensus" : "deterministic";
  let consensus: ConsensusReviewResult | null = null;
  if (deterministic.pass && reviewLevel === "consensus") {
    try {
      consensus = await (deps.consensus ?? defaultConsensusReview)(input);
    } catch (error) {
      consensus = {
        pass: false,
        summary: error instanceof Error ? error.message : String(error),
        consensus_id: null,
        confidence: null,
      };
    }
  }
  const personaPass = personaReviews?.mode !== "enforce" || personaReviews.pass;
  const pass = deterministic.pass && personaPass && (reviewLevel === "deterministic" || consensus?.pass === true);
  const substantiation = substantiate(consensus, input.prior_verification ?? null, personaReviews);
  const result: FactoryReviewResult = {
    version: 1,
    execution_id: input.execution_id,
    identifier: input.identifier,
    mode,
    review_level: reviewLevel,
    deterministic,
    consensus,
    pass,
    blocking: (mode === "enforce" && !pass) || (personaReviews?.mode === "enforce" && !personaReviews.pass),
    substantiated: substantiation.substantiated,
    substantiation: substantiation.reason,
    // Enforce may promote an implementation to `verified`, which is what makes
    // it shippable. Requiring substantive verification here is the difference
    // between "the diff is clean" and "something actually reviewed this".
    advance_to_verified: mode === "enforce" && pass && substantiation.substantiated,
    reviewed_at: (deps.now ?? (() => new Date().toISOString()))(),
    ...(personaReviews ? { persona_reviews: personaReviews } : {}),
  };
  if (deps.write_result !== false) {
    const stateDir = resolveFactoryStateOverride(input.state_dir);
    writeResult(join(stateDir, `review-${input.execution_id}.json`), result);
  }
  return result;
}

export function loadFactoryReview(path: string): FactoryReviewResult {
  return JSON.parse(readFileSync(path, "utf8")) as FactoryReviewResult;
}
