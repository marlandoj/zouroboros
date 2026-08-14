import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeCompetenceBand,
  countDomainHistory,
  disagreementFromConsensus,
  loadConsensusHistory,
  consensusHistoryPath,
  calibrateConsensusDecision,
  formatCompetenceReport,
  CALIBRATED_THRESHOLD,
  MEANINGFUL_THRESHOLD,
  DEFAULT_COMPETENCE_CONFIG,
  type ConsensusLike,
} from '../calibration/competence-band.js';

describe('disagreementFromConsensus', () => {
  test('unanimous is zero disagreement regardless of confidence', () => {
    expect(disagreementFromConsensus({ unanimous: true, confidence: 0.1 })).toBe(0);
    expect(disagreementFromConsensus({ unanimous: true })).toBe(0);
  });
  test('non-unanimous disagreement is 1 - confidence', () => {
    expect(disagreementFromConsensus({ unanimous: false, confidence: 0.8 })).toBeCloseTo(0.2, 6);
    expect(disagreementFromConsensus({ unanimous: false, confidence: 0.25 })).toBeCloseTo(0.75, 6);
  });
  test('missing confidence on a split reads as maximally uncertain', () => {
    expect(disagreementFromConsensus({ unanimous: false })).toBe(1);
  });
  test('clamps out-of-range confidence and handles undefined block', () => {
    expect(disagreementFromConsensus({ unanimous: false, confidence: 1.5 })).toBe(0);
    expect(disagreementFromConsensus({ unanimous: false, confidence: -0.2 })).toBe(1);
    expect(disagreementFromConsensus(undefined)).toBe(0);
  });
});

describe('countDomainHistory', () => {
  const records: ConsensusLike[] = [
    { criteria: 'correctness,security', label: 'a' },
    { criteria: 'correctness,security', label: 'b' },
    { criteria: 'design', label: 'c' },
    { criteria: '  correctness,security  ', label: 'd' }, // trimmed match
    { label: 'no-criteria' },
  ];
  test('counts exact (trimmed) matches on criteria by default', () => {
    expect(countDomainHistory(records, 'correctness,security')).toBe(3);
    expect(countDomainHistory(records, 'design')).toBe(1);
    expect(countDomainHistory(records, 'absent')).toBe(0);
  });
  test('can key on label dimension', () => {
    expect(countDomainHistory(records, 'c', 'label')).toBe(1);
  });
  test('empty history is zero', () => {
    expect(countDomainHistory([], 'anything')).toBe(0);
  });
});

describe('computeCompetenceBand — the three ADVISORY-ported bands', () => {
  test('n >= 20 → CALIBRATED, full trust, signal unscaled, not advisory', () => {
    const r = computeCompetenceBand('correctness', 25, 0.6);
    expect(r.band).toBe('CALIBRATED');
    expect(r.calibratedConfidence).toBe(1);
    expect(r.effectiveDisagreement).toBeCloseTo(0.6, 6);
    expect(r.thinHistory).toBe(false);
    expect(r.advisory).toBe(false);
  });
  test('exactly at the gate (n = 20) is CALIBRATED', () => {
    const r = computeCompetenceBand('correctness', CALIBRATED_THRESHOLD, 0.5);
    expect(r.band).toBe('CALIBRATED');
    expect(r.thinHistory).toBe(false);
  });
  test('5 <= n < 20 → PROVISIONAL, down-weighted, thin-history flag, advisory', () => {
    const r = computeCompetenceBand('correctness', 10, 0.6);
    expect(r.band).toBe('PROVISIONAL');
    expect(r.calibratedConfidence).toBeCloseTo(0.5, 6);
    expect(r.effectiveDisagreement).toBeCloseTo(0.3, 6); // renormalized: 0.6 * 0.5
    expect(r.thinHistory).toBe(true);
    expect(r.advisory).toBe(true);
    expect(r.note).toContain('📊');
  });
  test('n < 5 → UNCALIBRATED, heavily down-weighted, advisory', () => {
    const r = computeCompetenceBand('correctness', 2, 0.9);
    expect(r.band).toBe('UNCALIBRATED');
    expect(r.calibratedConfidence).toBeCloseTo(0.1, 6);
    expect(r.effectiveDisagreement).toBeCloseTo(0.09, 6);
    expect(r.thinHistory).toBe(true);
    expect(r.advisory).toBe(true);
    expect(r.note).toContain('📊');
  });
  test('exactly at meaningful threshold (n = 5) is PROVISIONAL not UNCALIBRATED', () => {
    expect(computeCompetenceBand('d', MEANINGFUL_THRESHOLD, 0.5).band).toBe('PROVISIONAL');
    expect(computeCompetenceBand('d', MEANINGFUL_THRESHOLD - 1, 0.5).band).toBe('UNCALIBRATED');
  });
  test('zero history → UNCALIBRATED with zero effective signal', () => {
    const r = computeCompetenceBand('brand-new', 0, 1);
    expect(r.band).toBe('UNCALIBRATED');
    expect(r.calibratedConfidence).toBe(0);
    expect(r.effectiveDisagreement).toBe(0);
  });
});

describe('computeCompetenceBand — invariants', () => {
  test('effectiveDisagreement is monotonic non-decreasing in history count', () => {
    let prev = -1;
    for (let n = 0; n <= 30; n++) {
      const eff = computeCompetenceBand('m', n, 0.7).effectiveDisagreement;
      expect(eff).toBeGreaterThanOrEqual(prev);
      prev = eff;
    }
  });
  test('effectiveDisagreement never exceeds rawDisagreement', () => {
    for (let n = 0; n <= 40; n++) {
      const r = computeCompetenceBand('m', n, 0.8);
      expect(r.effectiveDisagreement).toBeLessThanOrEqual(r.rawDisagreement + 1e-9);
    }
  });
  test('clamps raw disagreement and floors fractional / negative history', () => {
    const over = computeCompetenceBand('m', 25, 5);
    expect(over.rawDisagreement).toBe(1);
    const frac = computeCompetenceBand('m', 9.9, 0.5);
    expect(frac.domainHistoryCount).toBe(9);
    const neg = computeCompetenceBand('m', -3, 0.5);
    expect(neg.domainHistoryCount).toBe(0);
    expect(neg.band).toBe('UNCALIBRATED');
  });
  test('honors a custom config threshold', () => {
    const cfg = { calibratedThreshold: 4, meaningfulThreshold: 2 };
    expect(computeCompetenceBand('m', 4, 0.5, cfg).band).toBe('CALIBRATED');
    expect(computeCompetenceBand('m', 3, 0.5, cfg).band).toBe('PROVISIONAL');
    expect(computeCompetenceBand('m', 1, 0.5, cfg).band).toBe('UNCALIBRATED');
  });
  test('DEFAULT_COMPETENCE_CONFIG matches the exported thresholds', () => {
    expect(DEFAULT_COMPETENCE_CONFIG.calibratedThreshold).toBe(CALIBRATED_THRESHOLD);
    expect(DEFAULT_COMPETENCE_CONFIG.meaningfulThreshold).toBe(MEANINGFUL_THRESHOLD);
  });
});

describe('formatCompetenceReport', () => {
  test('includes band, n, and the note', () => {
    const line = formatCompetenceReport(computeCompetenceBand('correctness', 10, 0.6));
    expect(line).toContain('[PROVISIONAL]');
    expect(line).toContain('correctness');
    expect(line).toContain('n=10');
  });
});

describe('loadConsensusHistory + consensusHistoryPath', () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'consensus-hist-'));
    prevEnv = process.env.CONSENSUS_GATE_DB;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CONSENSUS_GATE_DB;
    else process.env.CONSENSUS_GATE_DB = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  test('absent file reads as empty (fail-safe, never throws)', () => {
    expect(loadConsensusHistory(join(dir, 'nope.json'))).toEqual([]);
  });
  test('malformed file reads as empty', () => {
    const f = join(dir, 'bad.json');
    writeFileSync(f, '{not json');
    expect(loadConsensusHistory(f)).toEqual([]);
  });
  test('non-array json reads as empty', () => {
    const f = join(dir, 'obj.json');
    writeFileSync(f, JSON.stringify({ criteria: 'x' }));
    expect(loadConsensusHistory(f)).toEqual([]);
  });
  test('loads a persisted array and feeds the band end to end', () => {
    const f = join(dir, 'consensus-gate.json');
    const records: ConsensusLike[] = [
      ...Array.from({ length: 22 }, () => ({ criteria: 'correctness,security' })),
      { criteria: 'design' },
    ];
    writeFileSync(f, JSON.stringify(records));
    const loaded = loadConsensusHistory(f);
    expect(loaded.length).toBe(23);

    const report = calibrateConsensusDecision(
      'correctness,security',
      { unanimous: false, confidence: 0.4 },
      { historyPath: f }
    );
    expect(report.band).toBe('CALIBRATED');
    expect(report.domainHistoryCount).toBe(22);
    expect(report.rawDisagreement).toBeCloseTo(0.6, 6);
    expect(report.effectiveDisagreement).toBeCloseTo(0.6, 6);
  });
  test('CONSENSUS_GATE_DB env is honored by consensusHistoryPath', () => {
    process.env.CONSENSUS_GATE_DB = join(dir, 'env.json');
    expect(consensusHistoryPath()).toBe(join(dir, 'env.json'));
    expect(consensusHistoryPath('/explicit/path.json')).toBe('/explicit/path.json');
  });
});

describe('calibrateConsensusDecision — thin domain surfaces advisory', () => {
  test('thin history with a split is advisory and renormalized down', () => {
    const records: ConsensusLike[] = [
      { criteria: 'novel-domain' },
      { criteria: 'novel-domain' },
    ];
    const report = calibrateConsensusDecision(
      'novel-domain',
      { unanimous: false, confidence: 0.5 },
      { records }
    );
    expect(report.band).toBe('UNCALIBRATED');
    expect(report.advisory).toBe(true);
    expect(report.effectiveDisagreement).toBeLessThan(report.rawDisagreement);
  });
});
