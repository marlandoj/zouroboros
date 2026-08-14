import { describe, test, expect } from 'bun:test';
import type { Playbook, MetricResult, GovernorReport } from '../types.js';
import { evaluatePrescription } from '../prescribe/governor.js';
import {
  proposeFromObservations,
  proposalToPlaybook,
  gateProposal,
  enforceBudget,
  budgetState,
  recordProposals,
  reconcileLedgerWithDecisions,
  coerceProposalDecisions,
  coercePersistedProposals,
  mergePersistedProposals,
  proposalIdFromObservationKey,
  toPersistedProposal,
  exploreCuriosity,
  emptyLedger,
  coerceCuriosityLedger,
  summarizeRun,
  DEFAULT_CURIOSITY_CONFIG,
  DEFAULT_MAX_PER_WINDOW,
  type Observation,
  type CuriosityLedger,
  type CuriosityProposal,
  type PersistedProposal,
} from '../curiosity/curiosity-explorer.js';

const NOW = 1_000_000_000_000;

function obs(key: string, weight: number, surface?: Observation['surface']): Observation {
  return { key, kind: 'wiring_gap', detail: `weakness ${key}`, weight, surface };
}

/** A governor stub that always approves — to isolate budget/proposal logic from governor logic. */
const APPROVE_ALL = (): GovernorReport => ({
  approved: true,
  flags: [],
  riskLevel: 'LOW',
  requiresHuman: false,
  reason: 'ok',
});

/** A governor stub that always escalates to a human. */
const REQUIRE_HUMAN = (): GovernorReport => ({
  approved: false,
  flags: ['needs review'],
  riskLevel: 'HIGH',
  requiresHuman: true,
  reason: 'held',
});

describe('proposeFromObservations — proposal-only, ranked, deduped', () => {
  test('every proposal is status "proposed" (never spawned)', () => {
    const ps = proposeFromObservations([obs('a', 0.5)], NOW);
    expect(ps).toHaveLength(1);
    expect(ps[0].status).toBe('proposed');
  });

  test('ranks by observation weight (highest first)', () => {
    const ps = proposeFromObservations([obs('lo', 0.2), obs('hi', 0.9), obs('mid', 0.5)], NOW);
    expect(ps.map((p) => p.observationKey)).toEqual(['hi', 'mid', 'lo']);
  });

  test('dedupes by observation key', () => {
    const ps = proposeFromObservations([obs('dup', 0.5), obs('dup', 0.9)], NOW);
    expect(ps).toHaveLength(1);
  });

  test('derives risk from the surface', () => {
    const schema = proposeFromObservations([obs('s', 0.5, { touchesSchema: true })], NOW)[0];
    const many = proposeFromObservations([obs('m', 0.5, { maxFiles: 5 })], NOW)[0];
    const bridge = proposeFromObservations([obs('b', 0.5, { targetFile: 'src/executor-bridge.ts' })], NOW)[0];
    const low = proposeFromObservations([obs('l', 0.5, { targetFile: 'src/util.ts' })], NOW)[0];
    expect(schema.risk).toBe('HIGH');
    expect(many.risk).toBe('MEDIUM');
    expect(bridge.risk).toBe('HIGH');
    expect(low.risk).toBe('LOW');
  });
});

describe('proposalToPlaybook — projection for the governor', () => {
  test('marks novel probes requiresApproval so the governor escalates', () => {
    const p = proposeFromObservations([obs('x', 0.5)], NOW)[0];
    const { playbook, metric } = proposalToPlaybook(p);
    expect(playbook.requiresApproval).toBe(true);
    expect(playbook.id).toContain('curiosity-');
    expect(metric.weight).toBe(0); // a probe is a tripwire, never an optimizer target
  });
});

describe('gateProposal — GOVERNOR-HARD', () => {
  test('not spawnable when the governor requires a human', () => {
    const p = proposeFromObservations([obs('x', 0.5)], NOW)[0];
    expect(gateProposal(p, REQUIRE_HUMAN).spawnable).toBe(false);
  });

  test('spawnable only when approved and no human required', () => {
    const p = proposeFromObservations([obs('x', 0.5)], NOW)[0];
    expect(gateProposal(p, APPROVE_ALL).spawnable).toBe(true);
  });

  test('the REAL governor holds every curiosity proposal (requiresApproval projection)', () => {
    // Because proposalToPlaybook sets requiresApproval=true, the real prescribe governor
    // always flags it -> requiresHuman -> not spawnable. Curiosity never auto-acts.
    const p = proposeFromObservations([obs('real', 0.9, { targetFile: 'src/util.ts' })], NOW)[0];
    const gated = gateProposal(p, evaluatePrescription);
    expect(gated.governor.requiresHuman).toBe(true);
    expect(gated.spawnable).toBe(false);
  });
});

describe('budget — HARD rate / open caps', () => {
  test('budgetState reflects window + open usage', () => {
    const ledger: CuriosityLedger = {
      version: 1,
      entries: [
        { key: 'a', proposedAt: NOW - 1000, status: 'open' },
        { key: 'b', proposedAt: NOW - 1000, status: 'resolved' },
        { key: 'c', proposedAt: NOW - DEFAULT_CURIOSITY_CONFIG.windowMs - 1, status: 'open' }, // outside window
      ],
    };
    const b = budgetState(ledger, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(b.windowUsed).toBe(2); // a + b within window; c is old
    expect(b.openCount).toBe(2); // a + c are open
  });

  test('enforceBudget emits at most the per-window remaining and refuses the rest', () => {
    const proposals = proposeFromObservations(
      [obs('a', 0.9), obs('b', 0.8), obs('c', 0.7), obs('d', 0.6)],
      NOW
    );
    const { emitted, refused } = enforceBudget(proposals, emptyLedger(), DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(emitted).toHaveLength(DEFAULT_MAX_PER_WINDOW);
    expect(refused).toHaveLength(4 - DEFAULT_MAX_PER_WINDOW);
  });

  test('does not re-propose an already-open key', () => {
    const ledger: CuriosityLedger = { version: 1, entries: [{ key: 'a', proposedAt: NOW, status: 'open' }] };
    const proposals = proposeFromObservations([obs('a', 0.9), obs('b', 0.8)], NOW);
    const { emitted } = enforceBudget(proposals, ledger, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(emitted.map((p) => p.observationKey)).toEqual(['b']);
  });

  test('does not immediately re-propose a decided historical key', () => {
    const ledger: CuriosityLedger = {
      version: 1,
      entries: [
        { key: 'accepted', proposedAt: NOW - 1000, status: 'resolved' },
        { key: 'rejected', proposedAt: NOW - 1000, status: 'dismissed' },
      ],
    };
    const proposals = proposeFromObservations(
      [obs('accepted', 0.9), obs('rejected', 0.8), obs('fresh', 0.7)],
      NOW
    );
    const { emitted } = enforceBudget(proposals, ledger, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(emitted.map((p) => p.observationKey)).toEqual(['fresh']);
  });

  test('assigns a migration timestamp when a terminal legacy entry has no decision timestamp', () => {
    const ledger: CuriosityLedger = {
      version: 1,
      entries: [{ key: 'unknown-decision-time', proposedAt: 0, status: 'resolved' }],
    };
    const migrated = coerceCuriosityLedger(ledger, NOW);
    expect(migrated.entries[0].decidedAt).toBe(NOW);
    const proposals = proposeFromObservations([obs('unknown-decision-time', 0.9)], NOW);
    expect(enforceBudget(proposals, migrated, DEFAULT_CURIOSITY_CONFIG, NOW).emitted).toHaveLength(0);
  });

  test('allows a terminal finding to recur after the cooldown', () => {
    const config = { ...DEFAULT_CURIOSITY_CONFIG, reproposalCooldownMs: 1000 };
    const ledger: CuriosityLedger = {
      version: 1,
      entries: [{ key: 'again', proposedAt: NOW - 5000, decidedAt: NOW - 2000, status: 'resolved' }],
    };
    const proposals = proposeFromObservations([obs('again', 0.9)], NOW);
    const [recurrence] = enforceBudget(proposals, ledger, config, NOW).emitted;
    expect(recurrence.id).not.toBe(proposalIdFromObservationKey('again'));

    const recorded = recordProposals(ledger, [recurrence]);
    const reconciled = reconcileLedgerWithDecisions(recorded, {
      [proposalIdFromObservationKey('again')]: { decision: 'accept', votedAt: NOW - 2000 },
    });
    expect(reconciled.ledger.entries.map((entry) => entry.status)).toEqual(['resolved', 'open']);
  });

  test('open cap blocks emission even with window budget free', () => {
    const cfg = { ...DEFAULT_CURIOSITY_CONFIG, maxOpen: 1 };
    const ledger: CuriosityLedger = { version: 1, entries: [{ key: 'x', proposedAt: NOW, status: 'open' }] };
    const proposals = proposeFromObservations([obs('a', 0.9)], NOW);
    const { emitted, refused } = enforceBudget(proposals, ledger, cfg, NOW);
    expect(emitted).toHaveLength(0);
    expect(refused).toHaveLength(1);
  });

  test('recordProposals appends emitted as open entries', () => {
    const emitted = proposeFromObservations([obs('a', 0.9)], NOW);
    const next = recordProposals(emptyLedger(), emitted);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toEqual({
      key: 'a',
      proposalId: proposalIdFromObservationKey('a'),
      proposedAt: NOW,
      status: 'open',
    });
  });
});

describe('ledger reconciliation and proposal archive', () => {
  test('ledger parsing fails closed on null and malformed records', () => {
    expect(coerceCuriosityLedger(null)).toEqual(emptyLedger());
    expect(coerceCuriosityLedger({ version: 1 })).toEqual(emptyLedger());
    expect(
      coerceCuriosityLedger({
        version: 1,
        entries: [null, { key: 'ok', proposedAt: NOW, status: 'open' }, { key: 5, status: 'open' }],
      }).entries
    ).toEqual([{ key: 'ok', proposedAt: NOW, status: 'open' }]);
  });

  test('proposal ids remain legacy-compatible and disambiguate actual collisions', () => {
    expect(proposalIdFromObservationKey('unreachable:createOptimizer')).toBe('unreachable-createOptimizer');
    expect(proposalIdFromObservationKey('a:b-c')).toBe('a-b-c');
    const collisions = proposeFromObservations([obs('a:b-c', 0.8), obs('a-b:c', 0.7)], NOW);
    expect(collisions[0].id).not.toBe(collisions[1].id);
  });

  test('decision parsing rejects null and malformed records', () => {
    expect(coerceProposalDecisions(null)).toEqual({});
    expect(coerceProposalDecisions({ bad: null, wrong: { decision: 'maybe', votedAt: NOW } })).toEqual({});
    expect(coerceProposalDecisions({ ok: { decision: 'accept', votedAt: NOW } })).toEqual({
      ok: { decision: 'accept', votedAt: NOW },
    });
  });

  test('proposal archive parsing rejects malformed records', () => {
    const valid = toPersistedProposal(
      gateProposal(proposeFromObservations([obs('valid', 0.8)], NOW)[0], APPROVE_ALL)
    );
    expect(coercePersistedProposals(null)).toEqual([]);
    expect(coercePersistedProposals([null, { id: 'broken' }, valid])).toEqual([valid]);
  });

  test('accept resolves, reject dismisses, and defer reopens without mutating input', () => {
    const ledger: CuriosityLedger = {
      version: 1,
      entries: [
        { key: 'a', proposedAt: NOW, status: 'open' },
        { key: 'b', proposedAt: NOW, status: 'open' },
        { key: 'c', proposedAt: NOW, status: 'resolved' },
      ],
    };
    const result = reconcileLedgerWithDecisions(ledger, {
      a: { decision: 'accept', votedAt: NOW },
      b: { decision: 'reject', votedAt: NOW },
      c: { decision: 'defer', votedAt: NOW },
    });
    expect(ledger.entries.map((entry) => entry.status)).toEqual(['open', 'open', 'resolved']);
    expect(result.ledger.entries.map((entry) => entry.status)).toEqual(['resolved', 'dismissed', 'open']);
    expect({ resolved: result.resolved, dismissed: result.dismissed, reopened: result.reopened }).toEqual({
      resolved: 1,
      dismissed: 1,
      reopened: 1,
    });
  });

  test('an earlier vote does not decide a distinct recurrence', () => {
    const key = 'recurring:key';
    const baseId = proposalIdFromObservationKey(key);
    const ledger: CuriosityLedger = {
      version: 1,
      entries: [
        { key, proposalId: baseId, proposedAt: NOW - 2000, status: 'open' },
        { key, proposalId: `${baseId}-later`, proposedAt: NOW - 1000, status: 'open' },
      ],
    };
    const result = reconcileLedgerWithDecisions(ledger, {
      [baseId]: { decision: 'accept', votedAt: NOW },
    });
    expect(result.ledger.entries.map((entry) => entry.status)).toEqual(['resolved', 'open']);
  });

  test('archive merge updates an occurrence and retains later occurrences of the same finding', () => {
    const first = toPersistedProposal(gateProposal(proposeFromObservations([obs('a', 0.8)], NOW)[0], APPROVE_ALL));
    const refreshed = {
      ...first,
      hypothesis: 'updated evidence',
      proposedAt: NOW + 1000,
    } satisfies PersistedProposal;
    const second = toPersistedProposal(
      gateProposal(proposeFromObservations([obs('b', 0.7)], NOW + 1000)[0], APPROVE_ALL)
    );
    const recurrence = {
      ...first,
      id: 'a-recurrence',
      proposedAt: NOW + 2000,
    } satisfies PersistedProposal;
    const archive = mergePersistedProposals([first], [refreshed, second, recurrence]);
    expect(archive).toHaveLength(3);
    expect(archive.find((proposal) => proposal.id === first.id)).toMatchObject({
      id: first.id,
      hypothesis: 'updated evidence',
      proposedAt: NOW,
    });
    expect(archive.find((proposal) => proposal.id === recurrence.id)?.observationKey).toBe('a');
  });
});

describe('exploreCuriosity — full pass is proposal-only', () => {
  test('emits within budget, gates each, never exceeds caps', () => {
    const observations = [obs('a', 0.9), obs('b', 0.8), obs('c', 0.7), obs('d', 0.6)];
    const run = exploreCuriosity(observations, emptyLedger(), APPROVE_ALL, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(run.emitted).toBe(DEFAULT_MAX_PER_WINDOW);
    expect(run.refusedByBudget).toBe(4 - DEFAULT_MAX_PER_WINDOW);
    expect(run.proposals).toHaveLength(DEFAULT_MAX_PER_WINDOW);
    expect(run.ledger.entries).toHaveLength(DEFAULT_MAX_PER_WINDOW);
  });

  test('with the REAL governor, nothing is spawnable (governor-hard)', () => {
    const run = exploreCuriosity([obs('a', 0.9)], emptyLedger(), evaluatePrescription, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(run.spawnableCount).toBe(0);
    expect(run.proposals.every((g) => g.proposal.status === 'proposed')).toBe(true);
  });

  test('a second pass is blocked by the open cap until proposals resolve', () => {
    const cfg = { ...DEFAULT_CURIOSITY_CONFIG, maxPerWindow: 100, maxOpen: 2 };
    const first = exploreCuriosity([obs('a', 0.9), obs('b', 0.8)], emptyLedger(), APPROVE_ALL, cfg, NOW);
    expect(first.emitted).toBe(2);
    const second = exploreCuriosity([obs('c', 0.7)], first.ledger, APPROVE_ALL, cfg, NOW + 1);
    expect(second.emitted).toBe(0); // open cap reached
    expect(second.refusedByBudget).toBe(1);
  });

  test('summarizeRun states PROPOSAL-ONLY', () => {
    const run = exploreCuriosity([obs('a', 0.9)], emptyLedger(), APPROVE_ALL, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(summarizeRun(run)).toContain('PROPOSAL-ONLY');
  });

  test('empty observations produce an empty, side-effect-free run', () => {
    const run = exploreCuriosity([], emptyLedger(), APPROVE_ALL, DEFAULT_CURIOSITY_CONFIG, NOW);
    expect(run.emitted).toBe(0);
    expect(run.ledger.entries).toHaveLength(0);
  });
});
