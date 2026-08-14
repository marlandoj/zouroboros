#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  hashPlanArtifact,
  parsePlanArtifactInput,
} from '../plan-gate/canonicalize.js';
import { PlanGateLedger } from '../plan-gate/ledger.js';
import { evaluatePlanGatePolicy } from '../plan-gate/policy.js';
import type {
  PlanReviewProvider,
  PlanReviewRequest,
  PlanReviewResult,
} from '../plan-gate/provider.js';
import {
  parseTrustedPublicKeys,
  signApprovalReceipt,
  verifyApprovalReceipt,
} from '../plan-gate/receipt.js';
import { runRevisionController } from '../plan-gate/revise.js';
import type {
  ApprovalReceipt,
  FindingType,
  LedgerRecord,
  PlanArtifact,
  PlanGateMode,
  PlanGateResult,
  ProviderHealthStatus,
  ReceiptType,
} from '../plan-gate/types.js';
import { validatePlanArtifact } from '../plan-gate/validate.js';
import type { CanonicalizeFormat } from '../plan-gate/canonicalize.js';

const USAGE = `
zouroboros-plan-gate - pre-execution plan governance

Usage:
  zouroboros-plan-gate validate --plan <path> [--workspace-root <path>] [--format yaml|json|markdown] [--json]
  zouroboros-plan-gate review   --plan <path> --provider-command <executable> [--provider-arg <arg>] [--json]
  zouroboros-plan-gate revise   --plan <path> --provider-command <executable> [--max-rounds 3] [--json]
  zouroboros-plan-gate accept   --plan <path> --actor-id <id> --actor-source <source> --authorization <evidence> --gate-run-id <id> [--out <path>]
  zouroboros-plan-gate override --plan <path> --actor-id <id> --actor-source <source> --authorization <evidence> --gate-run-id <id> --reason <text> [--out <path>]
  zouroboros-plan-gate inspect  --receipt <path> [--plan <path>] [--mode advisory|shadow|enforce] [--json]

Provider subprocess contract:
  The executable receives a PlanReviewRequest JSON object on stdin and must emit
  one PlanReviewResult JSON object on stdout. Add fixed arguments with repeated
  --provider-arg values. PLAN_GATE_PROVIDER_COMMAND and PLAN_GATE_PROVIDER_ARGS
  provide equivalent environment configuration.

Receipt trust:
  PLAN_GATE_SIGNING_PRIVATE_KEY signs acceptance and override receipts.
  PLAN_GATE_SIGNING_KEY_ID identifies that key.
  PLAN_GATE_TRUSTED_PUBLIC_KEYS is a JSON key-id map used by inspect/enforcement.
`.trim();

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    plan: { type: 'string', short: 'p' },
    receipt: { type: 'string', short: 'r' },
    format: { type: 'string', short: 'f' },
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
    out: { type: 'string', short: 'o' },
    mode: { type: 'string' },
    ledger: { type: 'string' },
    'workspace-root': { type: 'string' },
    revision: { type: 'string' },
    'max-rounds': { type: 'string' },
    'provider-command': { type: 'string' },
    'provider-arg': { type: 'string', multiple: true },
    'actor-id': { type: 'string' },
    'actor-source': { type: 'string' },
    authorization: { type: 'string' },
    reason: { type: 'string' },
    'gate-run-id': { type: 'string', multiple: true },
    'expires-in-hours': { type: 'string' },
  },
  allowPositionals: true,
});

const command = values.help ? 'help' : (positionals[0] ?? 'help');
const asJson = values.json ?? false;

function emit(data: unknown): void {
  if (asJson || typeof data !== 'string') {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${data}\n`);
  }
}

function fail(message: string): never {
  emit({ command, error: message });
  process.exit(1);
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

function planFormat(planPath: string): CanonicalizeFormat {
  const requested = values.format;
  if (requested === 'yaml' || requested === 'json' || requested === 'markdown') return requested;
  if (requested !== undefined) fail('--format must be yaml, json, or markdown');
  if (/\.json$/i.test(planPath)) return 'json';
  if (/\.md$/i.test(planPath)) return 'markdown';
  return 'yaml';
}

function loadPlan(): { artifact: PlanArtifact; planPath: string; format: CanonicalizeFormat } {
  const planPath = values.plan;
  if (!planPath) fail('--plan is required');
  const format = planFormat(planPath);
  const raw = readFileSync(planPath, 'utf8');
  const artifact = parsePlanArtifactInput(raw, format) as PlanArtifact;
  return { artifact, planPath, format };
}

function validationOptions(): { workspaceRoot?: string } {
  return { workspaceRoot: values['workspace-root'] ?? process.env.ZO_WORKSPACE };
}

function providerArgs(): string[] {
  if (values['provider-arg']) return values['provider-arg'];
  const raw = process.env.PLAN_GATE_PROVIDER_ARGS;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    fail('PLAN_GATE_PROVIDER_ARGS must be a JSON string array');
  }
  return parsed as string[];
}

class CommandPlanReviewProvider implements PlanReviewProvider {
  private readonly executable: string;
  private readonly args: string[];

  constructor(executable: string, args: string[]) {
    this.executable = executable;
    this.args = args;
  }

  async review(request: PlanReviewRequest): Promise<PlanReviewResult> {
    const processHandle = Bun.spawn([this.executable, ...this.args], {
      stdin: new Blob([JSON.stringify(request)]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Plan review provider exited ${exitCode}: ${stderr.trim() || 'no stderr'}`);
    }
    const parsed = JSON.parse(stdout) as PlanReviewResult;
    if (!parsed || !Array.isArray(parsed.verdicts) || typeof parsed.decision !== 'string') {
      throw new Error('Plan review provider returned an invalid PlanReviewResult');
    }
    return parsed;
  }

  async estimateCost(): Promise<number> {
    const raw = Number(process.env.PLAN_GATE_PROVIDER_ESTIMATED_COST_USD ?? '0');
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  async checkHealth(): Promise<Record<string, ProviderHealthStatus>> {
    return { command_provider: 'unknown' };
  }
}

function provider(): PlanReviewProvider {
  const executable = values['provider-command'] ?? process.env.PLAN_GATE_PROVIDER_COMMAND;
  if (!executable) fail('--provider-command or PLAN_GATE_PROVIDER_COMMAND is required');
  return new CommandPlanReviewProvider(executable, providerArgs());
}

function findingCounts(findings: PlanGateResult['findings'] = []): Record<FindingType, number> {
  const counts: Record<FindingType, number> = {
    substantive: 0,
    infrastructure: 0,
    formatting: 0,
    out_of_scope: 0,
    provider_failure: 0,
    abstention: 0,
    malformed_output: 0,
  };
  for (const finding of findings) counts[finding.finding_type] += 1;
  return counts;
}

function ledger(): PlanGateLedger {
  return new PlanGateLedger({ ledgerPath: values.ledger });
}

function appendReviewRecord(result: PlanGateResult): void {
  ledger().append({
    record_id: randomUUID(),
    artifact_sha256: result.artifact_sha256,
    revision: result.revision,
    gate_run_id: result.gate_run_id,
    decision: result.decision,
    policy_mode: result.policy.mode,
    timestamp: result.timestamp,
    provider_health_summary: result.provider_health,
    call_count: result.call_accounting.calls_made,
    cost_usd: result.call_accounting.estimated_cost_usd,
    finding_counts: findingCounts(result.findings),
  });
}

function appendReceiptRecord(receipt: ApprovalReceipt, policyMode: LedgerRecord['policy_mode']): void {
  ledger().append({
    record_id: randomUUID(),
    artifact_sha256: receipt.artifact_sha256,
    revision: receipt.revision ?? 1,
    gate_run_id: receipt.gate_run_ids.at(-1) ?? 'operator-decision',
    decision: receipt.decision === 'overridden' ? 'overridden' : 'passed',
    policy_mode: policyMode,
    timestamp: receipt.timestamp,
    actor_id: receipt.actor.id,
    receipt_type: receipt.receipt_type,
    override_reason: receipt.reason,
    provider_health_summary: {},
    call_count: 0,
    cost_usd: 0,
    finding_counts: findingCounts(),
  });
}

function receiptTypeFor(commandName: string): ReceiptType {
  return commandName === 'override' ? 'override' : 'approval';
}

function issueReceipt(commandName: 'accept' | 'override'): ApprovalReceipt {
  const { artifact } = loadPlan();
  const actorId = values['actor-id'];
  const actorSource = values['actor-source'];
  const authorization = values.authorization;
  const gateRunIds = values['gate-run-id'] ?? [];
  if (!actorId || !actorSource || !authorization) {
    fail('--actor-id, --actor-source, and --authorization are required');
  }
  if (gateRunIds.length === 0) fail('at least one --gate-run-id is required');
  if (commandName === 'override' && !values.reason) fail('--reason is required for override');

  const now = new Date();
  const expiresInHours = positiveInteger(values['expires-in-hours'], 24, '--expires-in-hours');
  const base: ApprovalReceipt = {
    receipt_type: receiptTypeFor(commandName),
    artifact_sha256: hashPlanArtifact(artifact),
    gate_run_ids: gateRunIds,
    decision: commandName === 'override' ? 'overridden' : 'accepted',
    actor: { id: actorId, source: actorSource, authorization },
    reason: values.reason,
    timestamp: now.toISOString(),
    expiry: new Date(now.getTime() + expiresInHours * 60 * 60 * 1_000).toISOString(),
    signed: false,
    enforcement_eligible: false,
    revision: positiveInteger(values.revision, artifact.revision ?? 1, '--revision'),
  };
  const privateKey = process.env.PLAN_GATE_SIGNING_PRIVATE_KEY;
  const keyId = process.env.PLAN_GATE_SIGNING_KEY_ID;
  if ((privateKey && !keyId) || (!privateKey && keyId)) {
    fail('PLAN_GATE_SIGNING_PRIVATE_KEY and PLAN_GATE_SIGNING_KEY_ID must be configured together');
  }
  return privateKey && keyId
    ? signApprovalReceipt(base, { keyId, privateKey })
    : base;
}

async function main(): Promise<void> {
  if (command === 'help') {
    emit(USAGE);
    return;
  }

  if (command === 'validate') {
    const { artifact, planPath, format } = loadPlan();
    const result = {
      command,
      plan_path: planPath,
      format,
      artifact_sha256: hashPlanArtifact(artifact),
      policy: evaluatePlanGatePolicy(artifact),
      deterministic_report: validatePlanArtifact(artifact, validationOptions()),
    };
    emit(result);
    if (!result.deterministic_report.passed) process.exitCode = 2;
    return;
  }

  if (command === 'review' || command === 'revise') {
    const { artifact } = loadPlan();
    const maxRounds = command === 'review'
      ? 1
      : positiveInteger(values['max-rounds'], 3, '--max-rounds');
    const result = await runRevisionController(
      artifact,
      provider(),
      positiveInteger(values.revision, artifact.revision ?? 1, '--revision'),
      { maxRevisionRounds: maxRounds, validationOptions: validationOptions() }
    );
    for (const gateResult of result.gate_results) appendReviewRecord(gateResult);
    emit({ command, ...result });
    if (result.decision !== 'passed') process.exitCode = 2;
    return;
  }

  if (command === 'accept' || command === 'override') {
    const receipt = issueReceipt(command);
    const policy = evaluatePlanGatePolicy(loadPlan().artifact);
    appendReceiptRecord(receipt, policy.mode);
    if (values.out) writeFileSync(values.out, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    emit({ command, receipt, output_path: values.out });
    return;
  }

  if (command === 'inspect') {
    const receiptPath = values.receipt;
    if (!receiptPath) fail('--receipt is required');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as ApprovalReceipt;
    const artifactSha256 = values.plan ? hashPlanArtifact(loadPlan().artifact) : receipt.artifact_sha256;
    const requestedMode = values.mode ?? 'advisory';
    if (!['disabled', 'advisory', 'shadow', 'enforce'].includes(requestedMode)) {
      fail('--mode must be disabled, advisory, shadow, or enforce');
    }
    const verification = verifyApprovalReceipt(receipt, {
      artifactSha256,
      revision: values.revision ? positiveInteger(values.revision, 1, '--revision') : undefined,
      mode: requestedMode as PlanGateMode,
      trustedKeys: parseTrustedPublicKeys(process.env.PLAN_GATE_TRUSTED_PUBLIC_KEYS),
    });
    emit({ command, receipt_path: receiptPath, verification, receipt });
    if (!verification.valid || (requestedMode === 'enforce' && !verification.enforcement_eligible)) {
      process.exitCode = 2;
    }
    return;
  }

  fail(`unknown command '${command}'`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
