#!/usr/bin/env bun
/**
 * Standalone runner for the endogenous curiosity explorer (ZOU-283, #6).
 *
 * The reachable orchestrator that wires the CI-tested explorer
 * (curiosity/curiosity-explorer.ts) to live signals and the REAL governor:
 *   1. gathers observations of un-instrumented weaknesses from the Wiring Sentinel
 *      (scanWiring findings the scorecard does not yet measure),
 *   2. runs exploreCuriosity under the hard rate/open budget, gating EVERY proposal through
 *      the real prescribe governor (evaluatePrescription),
 *   3. persists the budget ledger and writes the governor-gated proposals to the data dir
 *      for human review.
 *
 * PROPOSAL-ONLY by construction: this runner never invokes prescribe or evolve. `spawnable`
 * is reported for a human to act on; nothing is spawned here. ("Wire last, governor-hard.")
 *
 * Lives under standalone/ (tsc-excluded) — it scans the source tree — but is seen by the
 * Wiring Sentinel, so importing the explorer functions here marks them reachable.
 *
 * Options:
 *   --json              machine-readable CuriosityRun output.
 *   --dry-run           do not persist the ledger (compute + report only).
 *   --max <n>           override max proposals per window for this run.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from 'zouroboros-core';
import {
  exploreCuriosity,
  summarizeRun,
  emptyLedger,
  coerceCuriosityLedger,
  gateProposal,
  proposeFromObservations,
  reconcileLedgerWithDecisions,
  coerceProposalDecisions,
  coercePersistedProposals,
  mergePersistedProposals,
  toPersistedProposal,
  DEFAULT_CURIOSITY_CONFIG,
  type Observation,
  type CuriosityLedger,
  type CuriosityConfig,
  type PersistedProposal,
  type ProposalDecisionRecord,
} from '../curiosity/curiosity-explorer.js';
import { scanWiring, type WiringFinding } from '../introspect/wiring.js';
import { evaluatePrescription } from '../prescribe/governor.js';

const DATA_DIR = getDataDir();
const LEDGER_PATH = join(DATA_DIR, 'curiosity-ledger.json');
const PROPOSALS_PATH = join(DATA_DIR, 'curiosity-proposals.json');
const VOTES_PATH = join(DATA_DIR, 'chronicle-votes.json');

/** Map a Wiring Sentinel finding to a curiosity observation (an un-instrumented weakness). */
function findingToObservation(f: WiringFinding): Observation {
  const targetFile = f.evidence.split(':')[0] || undefined;
  // Higher salience for capability-level defects than for path/lint-class findings.
  const weight =
    f.kind === 'unreachable' || f.kind === 'empty_store' || f.kind === 'unbound_trigger'
      ? 0.8
      : f.kind === 'half_wired_sentinel'
        ? 0.7
        : 0.5;
  return {
    key: `${f.kind}:${f.symbol}`,
    kind: 'wiring_gap',
    detail: `${f.kind} — ${f.symbol} (${f.evidence})`,
    weight,
    surface: { targetFile, maxFiles: 1, touchesSchema: /schema|migration/.test(f.symbol) },
  };
}

function gatherObservations(): Observation[] {
  let findings: WiringFinding[] = [];
  try {
    findings = scanWiring().findings;
  } catch {
    findings = [];
  }
  return findings.map(findingToObservation);
}

function loadLedger(): CuriosityLedger {
  if (!existsSync(LEDGER_PATH)) return emptyLedger();
  try {
    return coerceCuriosityLedger(JSON.parse(readFileSync(LEDGER_PATH, 'utf-8')));
  } catch {
    return emptyLedger();
  }
}

function loadProposals(): PersistedProposal[] {
  if (!existsSync(PROPOSALS_PATH)) return [];
  try {
    return coercePersistedProposals(JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8')));
  } catch {
    return [];
  }
}

function loadDecisions(): Record<string, ProposalDecisionRecord> {
  if (!existsSync(VOTES_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(VOTES_PATH, 'utf-8')) as { votes?: unknown };
    return coerceProposalDecisions(parsed?.votes);
  } catch {
    return {};
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');

  const maxIdx = argv.indexOf('--max');
  const config: CuriosityConfig =
    maxIdx !== -1 && argv[maxIdx + 1]
      ? { ...DEFAULT_CURIOSITY_CONFIG, maxPerWindow: Number(argv[maxIdx + 1]) }
      : DEFAULT_CURIOSITY_CONFIG;

  const observations = gatherObservations();
  const reconciliation = reconcileLedgerWithDecisions(loadLedger(), loadDecisions());
  const run = exploreCuriosity(observations, reconciliation.ledger, evaluatePrescription, config);
  const proposalByKey = new Map(
    proposeFromObservations(observations).map((proposal) => [proposal.observationKey, proposal])
  );
  const recoverable = run.ledger.entries.flatMap((entry) => {
    const proposal = proposalByKey.get(entry.key);
    if (!proposal) return [];
    return [
      toPersistedProposal(
        gateProposal(
          {
            ...proposal,
            id: entry.proposalId ?? proposal.id,
            proposedAt: entry.proposedAt,
          },
          evaluatePrescription
        )
      ),
    ];
  });
  const archive = mergePersistedProposals(loadProposals(), [
    ...recoverable,
    ...run.proposals.map(toPersistedProposal),
  ]);

  if (!dryRun) {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    writeFileSync(LEDGER_PATH, JSON.stringify(run.ledger, null, 2));
    writeFileSync(PROPOSALS_PATH, JSON.stringify(archive, null, 2));
  }

  if (json) {
    console.log(JSON.stringify({ ...run, reconciliation, publishedProposals: archive.length }, null, 2));
  } else {
    console.log(summarizeRun(run));
    console.log(
      `  reconciled votes: ${reconciliation.resolved} resolved, ${reconciliation.dismissed} dismissed, ` +
        `${reconciliation.reopened} reopened; publication archive ${archive.length}`
    );
    for (const g of run.proposals) {
      console.log(
        `  [${g.spawnable ? 'spawnable' : 'HELD'}] ${g.proposal.risk} ${g.proposal.id} — ${g.governor.reason}`
      );
    }
    if (!dryRun) console.log(`  proposals → ${PROPOSALS_PATH}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`curiosity: ${(err as Error).message}`);
    process.exit(1);
  }
}
