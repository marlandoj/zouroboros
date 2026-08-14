/**
 * Curiosity Chronicle — the publishable feed for the endogenous curiosity explorer
 * (ZOU-300..303, downstream of #6).
 *
 * The explorer (curiosity-explorer.ts) surfaces un-instrumented weaknesses as governor-gated,
 * proposal-only `PersistedProposal`s. On its own that output is a raw JSON blob meant for a
 * human to skim. The Chronicle turns each proposal into a structured, reviewable entry —
 * rationale, risk, expected gain, status — and renders the set as markdown a person can read
 * and a page can filter. It also carries the lightweight voting layer (accept / defer /
 * reject) whose "accept" outcome is what FEEDS the governor escalation queue.
 *
 * Invariant preserved from the explorer: the Chronicle is read-and-publish only. It NEVER
 * spawns a prescribe/evolve cycle and NEVER mutates the explorer's budget ledger. Voting lives
 * in its own `ChronicleVotes` record so the explorer's budget accounting stays pure; the only
 * thing a vote produces here is an escalation signal for a human/governor to act on.
 *
 * Pure + IO-free + unit-tested. The standalone runner (standalone/chronicle.ts) does the fs IO
 * and imports these functions, which also marks them reachable to the Wiring Sentinel.
 */

import type { PersistedProposal, CuriosityRisk } from './curiosity-explorer.js';

/** A proposal's publication status, after folding in any vote. */
export type ChronicleStatus = 'spawnable' | 'held' | 'dismissed';

/** A human's verdict on a proposal. `accept` is the signal that feeds governor escalation. */
export type VoteDecision = 'accept' | 'defer' | 'reject';

export interface ChronicleVote {
  decision: VoteDecision;
  votedAt: number;
}

export interface ChronicleVotes {
  version: number;
  votes: Record<string, ChronicleVote>;
}

export const CHRONICLE_VOTES_VERSION = 1;

export function emptyVotes(): ChronicleVotes {
  return { version: CHRONICLE_VOTES_VERSION, votes: {} };
}

/** A proposal rendered for the Chronicle — everything the page and the markdown need. */
export interface ChronicleEntry {
  id: string;
  title: string;
  /** Coarse grouping for the page filter — the finding kind (e.g. "unreachable", "coverage_gap"). */
  domain: string;
  risk: CuriosityRisk;
  status: ChronicleStatus;
  /** Why this might be a weakness — the explorer's hypothesis plus what the probe would measure. */
  rationale: string;
  /** What instrumenting it would measure. */
  approach: string;
  /** Transparent 0..1 estimate of payoff (see {@link expectedGain}). */
  expectedGain: number;
  governorReason: string;
  /** The human verdict folded into this entry, if any. */
  vote: VoteDecision | null;
  proposedAt: number;
}

const RISK_GAIN_MULTIPLIER: Record<CuriosityRisk, number> = {
  // Riskier probes touch surfaces (schema/bridge/many-file) whose payoff is more uncertain,
  // so the same salience is discounted harder. LOW probes realize their salience in full.
  LOW: 1,
  MEDIUM: 0.7,
  HIGH: 0.4,
};

/**
 * Expected gain of probing a proposal, in [0,1]. Heuristic, deliberately transparent:
 *   expectedGain = weight × riskMultiplier(risk)
 * where `weight` is the explorer's salience for the observation and the risk multiplier
 * discounts payoff for riskier surfaces. This is a ranking aid for human review, NOT a
 * promise — curiosity is unvalidated by definition.
 */
export function expectedGain(p: Pick<PersistedProposal, 'weight' | 'risk'>): number {
  const raw = Math.max(0, Math.min(1, p.weight)) * RISK_GAIN_MULTIPLIER[p.risk];
  return Math.round(raw * 100) / 100;
}

/** Coarse domain for grouping/filtering — the finding kind prefix of the observation key. */
export function domainOf(p: Pick<PersistedProposal, 'observationKey'>): string {
  const prefix = p.observationKey.split(':')[0]?.trim();
  return prefix && prefix.length > 0 ? prefix : 'unknown';
}

/** Fold a vote into the publication status. Reject hides the entry; otherwise spawnability decides. */
export function statusOf(p: Pick<PersistedProposal, 'spawnable'>, vote: VoteDecision | null): ChronicleStatus {
  if (vote === 'reject') return 'dismissed';
  return p.spawnable ? 'spawnable' : 'held';
}

/** Render one proposal (plus any vote) into a Chronicle entry. */
export function toEntry(p: PersistedProposal, vote: VoteDecision | null = null): ChronicleEntry {
  return {
    id: p.id,
    title: p.probe.proposedMetric,
    domain: domainOf(p),
    risk: p.risk,
    status: statusOf(p, vote),
    rationale: p.hypothesis,
    approach: p.probe.approach,
    expectedGain: expectedGain(p),
    governorReason: p.governor.reason,
    vote,
    proposedAt: p.proposedAt,
  };
}

/** Render the full set of proposals into Chronicle entries, ranked by expected gain (desc). */
export function toEntries(proposals: PersistedProposal[], votes: ChronicleVotes = emptyVotes()): ChronicleEntry[] {
  return proposals
    .map((p) => toEntry(p, votes.votes[p.id]?.decision ?? null))
    .sort((a, b) => b.expectedGain - a.expectedGain);
}

export interface EntryFilter {
  status?: ChronicleStatus;
  domain?: string;
}

/** Filter entries for the page (by status and/or domain). An absent field matches everything. */
export function filterEntries(entries: ChronicleEntry[], filter: EntryFilter = {}): ChronicleEntry[] {
  const result = entries.filter(
    (e) => (filter.status ? e.status === filter.status : true) && (filter.domain ? e.domain === filter.domain : true)
  );
  console.error(
    `  [chronicle] filterEntries: ${entries.length} in → ${result.length} matched (status: ${filter.status ?? 'any'}, domain: ${filter.domain ?? 'any'})`
  );
  return result;
}

/** The distinct domains present, for populating a filter dropdown. */
export function domainsOf(entries: ChronicleEntry[]): string[] {
  return [...new Set(entries.map((e) => e.domain))].sort();
}

const RISK_BADGE: Record<CuriosityRisk, string> = { LOW: '🟢 LOW', MEDIUM: '🟡 MEDIUM', HIGH: '🔴 HIGH' };
const STATUS_BADGE: Record<ChronicleStatus, string> = {
  spawnable: '✅ spawnable',
  held: '⏸️ held for human',
  dismissed: '🚫 dismissed',
};

/** One Chronicle entry as a markdown section. */
export function entryToMarkdown(e: ChronicleEntry): string {
  const lines = [
    `### ${e.title}`,
    ``,
    `- **Domain:** ${e.domain}`,
    `- **Status:** ${STATUS_BADGE[e.status]}`,
    `- **Risk:** ${RISK_BADGE[e.risk]}`,
    `- **Expected gain:** ${e.expectedGain.toFixed(2)}`,
    `- **Rationale:** ${e.rationale}`,
    `- **Probe approach:** ${e.approach}`,
    `- **Governor:** ${e.governorReason}`,
  ];
  if (e.vote) lines.push(`- **Vote:** ${e.vote}`);
  return lines.join('\n');
}

export interface ChronicleMeta {
  generatedAt: number;
  /** Optional window label, e.g. "week of 2026-06-01". */
  window?: string;
}

/** Render the whole Chronicle as a markdown document. */
export function chronicleToMarkdown(entries: ChronicleEntry[], meta: ChronicleMeta): string {
  const date = new Date(meta.generatedAt).toISOString().slice(0, 10);
  const header = [
    `# Curiosity Chronicle`,
    ``,
    meta.window ? `_${meta.window} — generated ${date}_` : `_Generated ${date}_`,
    ``,
    `The endogenous curiosity explorer surfaces un-instrumented weaknesses as governor-gated,`,
    `proposal-only probes. Every entry below is a hypothesis for a human to act on — nothing here`,
    `has been spawned. Ranked by expected gain.`,
    ``,
  ];
  if (entries.length === 0) {
    return [...header, `_No open proposals this period._`, ``].join('\n');
  }
  const counts = {
    spawnable: entries.filter((e) => e.status === 'spawnable').length,
    held: entries.filter((e) => e.status === 'held').length,
    dismissed: entries.filter((e) => e.status === 'dismissed').length,
  };
  const summary = `**${entries.length} proposals** — ${counts.spawnable} spawnable, ${counts.held} held for human, ${counts.dismissed} dismissed.`;
  return [...header, summary, ``, ...entries.map(entryToMarkdown)].join('\n\n');
}

// ── Voting → governor escalation (ZOU-303) ────────────────────────────────────

/**
 * Cast a vote on a proposal (pure). Returns a NEW votes record — never mutates the input and
 * never touches the explorer's budget ledger. `accept` is the signal {@link escalations} reads.
 */
export function castVote(
  votes: ChronicleVotes,
  proposalId: string,
  decision: VoteDecision,
  now: number = Date.now()
): ChronicleVotes {
  return {
    version: votes.version ?? CHRONICLE_VOTES_VERSION,
    votes: { ...votes.votes, [proposalId]: { decision, votedAt: now } },
  };
}

/**
 * The proposals a human has ACCEPTED — the priority queue that feeds governor escalation. Every
 * curiosity probe is held by the governor (requiresHuman) by construction, so "accepted" is the
 * out-of-band human decision that a held probe is worth escalating for a real prescribe cycle.
 * This function only SURFACES that queue; turning an escalation into a cycle is still a separate,
 * deliberate act — the Chronicle never spawns.
 */
export function escalations(proposals: PersistedProposal[], votes: ChronicleVotes): ChronicleEntry[] {
  return proposals
    .filter((p) => votes.votes[p.id]?.decision === 'accept')
    .map((p) => toEntry(p, 'accept'))
    .sort((a, b) => b.expectedGain - a.expectedGain);
}
