import { describe, test, expect } from 'bun:test';
import type { EvalIntegrityReport } from '../introspect/holdout.js';
import type { InterventionDrift } from '../evolve/intervention-ledger.js';
import {
  auditCorpusDrift,
  gateDistillation,
  evaluateDistillationArtifact,
  buildCorpusSnapshot,
  corpusContentHash,
  summarizeDecision,
  DEFAULT_DISTILL_CONFIG,
  DEFAULT_MIN_EVAL_AGREEMENT,
  DEFAULT_MIN_CORPUS_EXAMPLES,
  type CorpusSnapshot,
  type RecentDriftFlag,
  type DriftAuditResult,
} from '../distill/distillation-gate.js';

function integrity(agreement: number): EvalIntegrityReport {
  // heldFrac/visibleFrac chosen so |held-vis| = 1-agreement
  return { heldFrac: agreement, visibleFrac: 1, agreement, heldCount: 5, visibleCount: 5 };
}

const FLAGGED: InterventionDrift = { visibleDelta: 0.12, hiddenDelta: 0, divergence: 0.12, goodhartFlag: true };
const NOT_FLAGGED: InterventionDrift = { visibleDelta: 0.05, hiddenDelta: 0.04, divergence: 0.01, goodhartFlag: false };

function driftFlag(createdAt: number, drift: InterventionDrift = FLAGGED): RecentDriftFlag {
  return { prescriptionId: `rx-${createdAt}`, playbookId: 'pb-1', createdAt, drift };
}

const CLEAN_AUDIT: DriftAuditResult = { clean: true, reasons: [], evalAgreement: 1, recentDriftCount: 0 };

function snapshot(exampleCount: number): CorpusSnapshot {
  return {
    exampleCount,
    facts: exampleCount,
    episodes: 0,
    procedures: 0,
    contentHash: 'deadbeef',
    takenAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('auditCorpusDrift — the hard anti-Goodhart dependency', () => {
  const now = 1_000_000_000_000;

  test('clean when eval agrees and no recent drift', () => {
    const r = auditCorpusDrift({ evalIntegrity: integrity(0.95), driftFlags: [], now });
    expect(r.clean).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.evalAgreement).toBeCloseTo(0.95, 6);
  });

  test('FAILS CLOSED when held-out bank is unmeasurable (null integrity)', () => {
    const r = auditCorpusDrift({ evalIntegrity: null, driftFlags: [], now });
    expect(r.clean).toBe(false);
    expect(r.reasons.join(' ')).toContain('unmeasurable');
  });

  test('not clean when agreement is below threshold', () => {
    const r = auditCorpusDrift({ evalIntegrity: integrity(0.5), driftFlags: [], now });
    expect(r.clean).toBe(false);
    expect(r.reasons.join(' ')).toContain('agreement');
  });

  test('agreement exactly at threshold is clean', () => {
    const r = auditCorpusDrift({ evalIntegrity: integrity(DEFAULT_MIN_EVAL_AGREEMENT), driftFlags: [], now });
    expect(r.clean).toBe(true);
  });

  test('not clean when a recent intervention tripped the Goodhart flag', () => {
    const r = auditCorpusDrift({
      evalIntegrity: integrity(1),
      driftFlags: [driftFlag(now - 1000)],
      now,
    });
    expect(r.clean).toBe(false);
    expect(r.recentDriftCount).toBe(1);
    expect(r.reasons.join(' ')).toContain('Goodhart');
  });

  test('drift outside the lookback window does not count', () => {
    const old = now - DEFAULT_DISTILL_CONFIG.driftLookbackMs - 1;
    const r = auditCorpusDrift({ evalIntegrity: integrity(1), driftFlags: [driftFlag(old)], now });
    expect(r.clean).toBe(true);
    expect(r.recentDriftCount).toBe(0);
  });

  test('non-flagged interventions never count as drift', () => {
    const r = auditCorpusDrift({
      evalIntegrity: integrity(1),
      driftFlags: [driftFlag(now - 1000, NOT_FLAGGED)],
      now,
    });
    expect(r.clean).toBe(true);
  });

  test('accumulates multiple failure reasons', () => {
    const r = auditCorpusDrift({
      evalIntegrity: integrity(0.4),
      driftFlags: [driftFlag(now - 1000)],
      now,
    });
    expect(r.clean).toBe(false);
    expect(r.reasons.length).toBe(2);
  });
});

describe('gateDistillation — refuse unless thick corpus AND clean audit', () => {
  test('refuses a thin corpus even when the audit is clean', () => {
    const d = gateDistillation(snapshot(DEFAULT_MIN_CORPUS_EXAMPLES - 1), CLEAN_AUDIT);
    expect(d.proceed).toBe(false);
    expect(d.manifest).toBeNull();
    expect(d.refusal).toContain('too thin');
  });

  test('refuses when the audit is not clean even with a thick corpus', () => {
    const dirty: DriftAuditResult = {
      clean: false,
      reasons: ['held-out/visible agreement 0.400 < 0.9'],
      evalAgreement: 0.4,
      recentDriftCount: 0,
    };
    const d = gateDistillation(snapshot(500), dirty);
    expect(d.proceed).toBe(false);
    expect(d.refusal).toContain('drift audit FAILED');
    expect(d.refusal).toContain('0.400');
  });

  test('proceeds and emits a manifest stamped with the authorizing audit', () => {
    const snap = snapshot(500);
    const d = gateDistillation(snap, CLEAN_AUDIT, { baseModel: 'qwen-7b', method: 'qlora' }, DEFAULT_DISTILL_CONFIG);
    expect(d.proceed).toBe(true);
    expect(d.refusal).toBeNull();
    expect(d.manifest).not.toBeNull();
    expect(d.manifest!.baseModel).toBe('qwen-7b');
    expect(d.manifest!.method).toBe('qlora');
    expect(d.manifest!.corpus).toBe(snap);
    expect(d.manifest!.audit).toBe(CLEAN_AUDIT);
    expect(d.manifest!.acceptance.examiner).toBe('held-out-hidden-bank');
    expect(d.manifest!.acceptance.maxRegression).toBe(DEFAULT_DISTILL_CONFIG.regressionTolerance);
  });

  test('manifest carries default + overridden hyperparams', () => {
    const d = gateDistillation(snapshot(500), CLEAN_AUDIT, { hyperparams: { epochs: 5 } });
    expect(d.manifest!.hyperparams.epochs).toBe(5);
    expect(d.manifest!.hyperparams.rank).toBe(16); // default retained
  });

  test('corpus minimum is exactly inclusive', () => {
    expect(gateDistillation(snapshot(DEFAULT_MIN_CORPUS_EXAMPLES), CLEAN_AUDIT).proceed).toBe(true);
  });
});

describe('evaluateDistillationArtifact — held-out acceptance gate', () => {
  test('accepts when held-out score holds within tolerance', () => {
    const v = evaluateDistillationArtifact(0.8, 0.79);
    expect(v.accept).toBe(true);
    expect(v.regression).toBeCloseTo(0.01, 6);
  });

  test('accepts an improvement', () => {
    const v = evaluateDistillationArtifact(0.8, 0.86);
    expect(v.accept).toBe(true);
    expect(v.regression).toBeLessThan(0);
  });

  test('rejects a regression beyond tolerance', () => {
    const v = evaluateDistillationArtifact(0.8, 0.7);
    expect(v.accept).toBe(false);
    expect(v.regression).toBeCloseTo(0.1, 6);
    expect(v.reason).toContain('regressed');
  });

  test('regression exactly at tolerance is accepted', () => {
    const v = evaluateDistillationArtifact(0.8, 0.8 - DEFAULT_DISTILL_CONFIG.regressionTolerance);
    expect(v.accept).toBe(true);
  });

  test('FAILS CLOSED on an unmeasurable post-score', () => {
    expect(evaluateDistillationArtifact(0.8, null).accept).toBe(false);
    expect(evaluateDistillationArtifact(0.8, NaN).accept).toBe(false);
  });
});

describe('corpus snapshot + fingerprint', () => {
  test('buildCorpusSnapshot sums example count', () => {
    const s = buildCorpusSnapshot({ facts: 10, episodes: 20, procedures: 5, itemKeys: ['a', 'b'] });
    expect(s.exampleCount).toBe(35);
    expect(s.facts).toBe(10);
    expect(s.contentHash).toHaveLength(8);
  });

  test('content hash is order-independent and deterministic', () => {
    expect(corpusContentHash(['a', 'b', 'c'])).toBe(corpusContentHash(['c', 'a', 'b']));
  });

  test('content hash changes when the corpus changes', () => {
    expect(corpusContentHash(['a', 'b'])).not.toBe(corpusContentHash(['a', 'b', 'c']));
  });

  test('empty corpus hashes stably', () => {
    expect(corpusContentHash([])).toBe(corpusContentHash([]));
  });
});

describe('summarizeDecision', () => {
  test('summarizes a proceed decision', () => {
    const d = gateDistillation(snapshot(500), CLEAN_AUDIT);
    expect(summarizeDecision(d)).toContain('PROCEED');
  });
  test('summarizes a refusal', () => {
    const d = gateDistillation(snapshot(1), CLEAN_AUDIT);
    expect(summarizeDecision(d)).toContain('REFUSE');
  });
});
