import { describe, test, expect } from 'bun:test';
import type { GovernorReport } from '../types.js';
import {
  proposeFromObservations,
  gateProposal,
  toPersistedProposal,
  type Observation,
  type PersistedProposal,
} from '../curiosity/curiosity-explorer.js';
import {
  expectedGain,
  domainOf,
  statusOf,
  toEntry,
  toEntries,
  filterEntries,
  domainsOf,
  entryToMarkdown,
  chronicleToMarkdown,
  castVote,
  emptyVotes,
  escalations,
} from '../curiosity/chronicle.js';

const NOW = 1_700_000_000_000;

function proposal(over: Partial<PersistedProposal> = {}): PersistedProposal {
  return {
    id: 'unreachable-fooExport',
    observationKey: 'unreachable:fooExport',
    hypothesis: 'Possible un-instrumented weakness: unreachable — fooExport',
    risk: 'LOW',
    weight: 0.8,
    probe: {
      proposedMetric: 'probe:unreachable:fooExport',
      approach: "Instrument wiring_gap 'unreachable:fooExport' and measure it before optimizing.",
      targetFile: 'src/foo.ts',
      maxFiles: 1,
      touchesSchema: false,
    },
    spawnable: false,
    governor: { approved: false, flags: ['needs review'], riskLevel: 'HIGH', requiresHuman: true, reason: 'held' },
    proposedAt: NOW,
    ...over,
  };
}

describe('expectedGain — transparent weight × risk heuristic', () => {
  test('LOW risk realizes full salience', () => {
    expect(expectedGain({ weight: 0.8, risk: 'LOW' })).toBe(0.8);
  });
  test('MEDIUM and HIGH discount payoff', () => {
    expect(expectedGain({ weight: 1, risk: 'MEDIUM' })).toBe(0.7);
    expect(expectedGain({ weight: 1, risk: 'HIGH' })).toBe(0.4);
  });
  test('clamps weight into [0,1]', () => {
    expect(expectedGain({ weight: 5, risk: 'LOW' })).toBe(1);
    expect(expectedGain({ weight: -2, risk: 'LOW' })).toBe(0);
  });
});

describe('domainOf — finding-kind prefix', () => {
  test('takes the prefix before the colon', () => {
    expect(domainOf({ observationKey: 'coverage_gap:barModule' })).toBe('coverage_gap');
  });
  test('falls back to unknown when there is no prefix', () => {
    expect(domainOf({ observationKey: '' })).toBe('unknown');
  });
});

describe('statusOf — vote folds into status', () => {
  test('reject hides the entry', () => {
    expect(statusOf({ spawnable: true }, 'reject')).toBe('dismissed');
  });
  test('spawnable when governor cleared it and not rejected', () => {
    expect(statusOf({ spawnable: true }, null)).toBe('spawnable');
    expect(statusOf({ spawnable: true }, 'accept')).toBe('spawnable');
  });
  test('held otherwise', () => {
    expect(statusOf({ spawnable: false }, null)).toBe('held');
    expect(statusOf({ spawnable: false }, 'defer')).toBe('held');
  });
});

describe('toEntry / toEntries — rendering and ranking', () => {
  test('maps a proposal into a Chronicle entry', () => {
    const e = toEntry(proposal());
    expect(e.id).toBe('unreachable-fooExport');
    expect(e.title).toBe('probe:unreachable:fooExport');
    expect(e.domain).toBe('unreachable');
    expect(e.status).toBe('held');
    expect(e.expectedGain).toBe(0.8);
    expect(e.vote).toBeNull();
  });

  test('ranks entries by expected gain (desc) and folds votes', () => {
    const proposals = [
      proposal({ id: 'lo', observationKey: 'a:lo', weight: 0.3 }),
      proposal({ id: 'hi', observationKey: 'b:hi', weight: 0.9 }),
    ];
    const votes = castVote(emptyVotes(), 'hi', 'accept', NOW);
    const entries = toEntries(proposals, votes);
    expect(entries.map((e) => e.id)).toEqual(['hi', 'lo']);
    expect(entries[0].vote).toBe('accept');
  });
});

describe('filterEntries / domainsOf — page filtering', () => {
  const entries = toEntries([
    proposal({ id: 'a', observationKey: 'unreachable:a', spawnable: true }),
    proposal({ id: 'b', observationKey: 'coverage_gap:b' }),
    proposal({ id: 'c', observationKey: 'unreachable:c' }),
  ]);

  test('filters by status', () => {
    expect(filterEntries(entries, { status: 'spawnable' }).map((e) => e.id)).toEqual(['a']);
  });
  test('filters by domain', () => {
    expect(filterEntries(entries, { domain: 'unreachable' }).map((e) => e.id).sort()).toEqual(['a', 'c']);
  });
  test('no filter returns everything', () => {
    expect(filterEntries(entries)).toHaveLength(3);
  });
  test('domainsOf is distinct + sorted', () => {
    expect(domainsOf(entries)).toEqual(['coverage_gap', 'unreachable']);
  });
});

describe('markdown rendering', () => {
  test('entry markdown carries the key fields', () => {
    const md = entryToMarkdown(toEntry(proposal()));
    expect(md).toContain('probe:unreachable:fooExport');
    expect(md).toContain('Expected gain');
    expect(md).toContain('Rationale');
    expect(md).toContain('held for human');
  });
  test('document has a header and a summary', () => {
    const md = chronicleToMarkdown(toEntries([proposal()]), { generatedAt: NOW });
    expect(md).toContain('# Curiosity Chronicle');
    expect(md).toContain('1 proposals');
  });
  test('empty state renders without entries', () => {
    const md = chronicleToMarkdown([], { generatedAt: NOW });
    expect(md).toContain('No open proposals');
  });
});

describe('voting → governor escalation (ZOU-303)', () => {
  test('castVote is immutable and records the decision', () => {
    const v0 = emptyVotes();
    const v1 = castVote(v0, 'x', 'accept', NOW);
    expect(v0.votes).toEqual({});
    expect(v1.votes.x).toEqual({ decision: 'accept', votedAt: NOW });
  });

  test('escalations surfaces only accepted proposals, ranked by gain', () => {
    const proposals = [
      proposal({ id: 'lo', observationKey: 'a:lo', weight: 0.3 }),
      proposal({ id: 'hi', observationKey: 'b:hi', weight: 0.9 }),
      proposal({ id: 'no', observationKey: 'c:no', weight: 0.95 }),
    ];
    let votes = castVote(emptyVotes(), 'lo', 'accept', NOW);
    votes = castVote(votes, 'hi', 'accept', NOW);
    votes = castVote(votes, 'no', 'reject', NOW);
    const queue = escalations(proposals, votes);
    expect(queue.map((e) => e.id)).toEqual(['hi', 'lo']); // 'no' rejected, ranked by gain
  });

  test('a rejected proposal is dismissed in its rendered status', () => {
    const votes = castVote(emptyVotes(), 'unreachable-fooExport', 'reject', NOW);
    expect(toEntries([proposal()], votes)[0].status).toBe('dismissed');
  });
});

describe('toPersistedProposal — shared producer/consumer schema (no drift)', () => {
  test('a gated proposal flattens losslessly into the persisted shape the Chronicle reads', () => {
    const obs: Observation = {
      key: 'unreachable:fooExport',
      kind: 'wiring_gap',
      detail: 'unreachable — fooExport',
      weight: 0.8,
      surface: { targetFile: 'src/foo.ts', maxFiles: 1, touchesSchema: false },
    };
    const gov = (): GovernorReport => ({
      approved: false,
      flags: ['needs review'],
      riskLevel: 'HIGH',
      requiresHuman: true,
      reason: 'held',
    });
    const gated = gateProposal(proposeFromObservations([obs], NOW)[0], gov);
    const persisted = toPersistedProposal(gated);
    // The Chronicle can render it end-to-end with no missing fields.
    const entry = toEntry(persisted);
    expect(entry.domain).toBe('unreachable');
    expect(entry.expectedGain).toBe(0.8);
    expect(entry.status).toBe('held');
    expect(persisted.observationKey).toBe('unreachable:fooExport');
  });
});
