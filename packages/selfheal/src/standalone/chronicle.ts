#!/usr/bin/env bun
/**
 * Standalone runner for the Curiosity Chronicle (ZOU-300..303).
 *
 * The reachable orchestrator that turns the explorer's persisted, governor-gated proposals
 * (curiosity-proposals.json, written by standalone/curiosity.ts) into a publishable feed:
 *   1. reads the PersistedProposal[] and the ChronicleVotes,
 *   2. renders Chronicle entries (rationale / risk / expected gain / status, ranked),
 *   3. writes `chronicle.md` (human/email) and `chronicle.json` (the zo.space page feed,
 *      including the distinct domains for the filter and the accepted-proposal escalation queue).
 *
 * READ-AND-PUBLISH ONLY by construction: this runner never spawns prescribe/evolve and never
 * mutates the explorer's budget ledger. Casting a vote writes ONLY chronicle-votes.json.
 *
 * Lives under standalone/ (tsc-excluded) but is seen by the Wiring Sentinel, so importing the
 * Chronicle functions here marks them reachable.
 *
 * Options:
 *   --json                       machine-readable page-feed output to stdout.
 *   --dry-run                    compute + report only; do not write chronicle.{md,json}.
 *   --window "<label>"           optional window label embedded in the output.
 *   --vote <proposalId> <accept|defer|reject>
 *                                record a human verdict (writes chronicle-votes.json) and exit.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from 'zouroboros-core';
import type { PersistedProposal } from '../curiosity/curiosity-explorer.js';
import {
  toEntries,
  domainsOf,
  escalations,
  chronicleToMarkdown,
  castVote,
  emptyVotes,
  type ChronicleVotes,
  type VoteDecision,
} from '../curiosity/chronicle.js';

const DATA_DIR = getDataDir();
const PROPOSALS_PATH = join(DATA_DIR, 'curiosity-proposals.json');
const VOTES_PATH = join(DATA_DIR, 'chronicle-votes.json');
const MD_PATH = join(DATA_DIR, 'chronicle.md');
const JSON_PATH = join(DATA_DIR, 'chronicle.json');

function loadProposals(): PersistedProposal[] {
  if (!existsSync(PROPOSALS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as PersistedProposal[]) : [];
  } catch {
    return [];
  }
}

function loadVotes(): ChronicleVotes {
  if (!existsSync(VOTES_PATH)) return emptyVotes();
  try {
    const parsed = JSON.parse(readFileSync(VOTES_PATH, 'utf-8')) as ChronicleVotes;
    return parsed && typeof parsed.votes === 'object' ? parsed : emptyVotes();
  } catch {
    return emptyVotes();
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const VALID_DECISIONS: VoteDecision[] = ['accept', 'defer', 'reject'];

function main(): void {
  const argv = process.argv.slice(2);

  const voteIdx = argv.indexOf('--vote');
  if (voteIdx !== -1) {
    const id = argv[voteIdx + 1];
    const decision = argv[voteIdx + 2] as VoteDecision;
    if (!id || !VALID_DECISIONS.includes(decision)) {
      console.error(`chronicle: --vote needs <proposalId> <${VALID_DECISIONS.join('|')}>`);
      process.exit(1);
    }
    const next = castVote(loadVotes(), id, decision);
    write(VOTES_PATH, JSON.stringify(next, null, 2));
    console.log(`chronicle: recorded vote ${decision} on ${id}${decision === 'accept' ? ' → queued for governor escalation' : ''}`);
    return;
  }

  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const winIdx = argv.indexOf('--window');
  const window = winIdx !== -1 ? argv[winIdx + 1] : undefined;

  const proposals = loadProposals();
  const votes = loadVotes();
  const entries = toEntries(proposals, votes);
  const generatedAt = Date.now();
  const feed = {
    generatedAt,
    window,
    entries,
    domains: domainsOf(entries),
    escalations: escalations(proposals, votes),
  };
  const markdown = chronicleToMarkdown(entries, { generatedAt, window });

  if (!dryRun) {
    write(MD_PATH, markdown);
    write(JSON_PATH, JSON.stringify(feed, null, 2));
  }

  if (json) {
    console.log(JSON.stringify(feed, null, 2));
  } else {
    console.log(
      `chronicle: ${entries.length} entries (${feed.domains.length} domains, ${feed.escalations.length} escalations)` +
        (dryRun ? ' — dry run, nothing written' : ` → ${MD_PATH}`)
    );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`chronicle: ${(err as Error).message}`);
    process.exit(1);
  }
}
