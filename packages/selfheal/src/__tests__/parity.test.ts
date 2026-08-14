import { describe, test, expect } from 'bun:test';
import {
  extractScorecardSurface,
  extractOptimizerSurface,
  scanMetricParity,
  type ParityManifest,
} from '../introspect/parity';

// Minimal synthetic surfaces. `buildMetric` is a no-op stub so the source parses; only the
// literal name (arg 0) and weight (arg 4) are read statically.
const PROD = (extra = '') => `
function buildMetric(...args: unknown[]) { return args; }
async function a() { return buildMetric('Memory Recall', 0.9, 0.85, 0.7, 0.25, 'd', 'r'); }
async function b() { return buildMetric('Wiring Health', 0.9, 0.8, 0.5, 0.12, 'd', 'r'); }
async function tw() { return buildMetric('Eval-Integrity', 1, 0.85, 0.6, 0, 'd', 'r'); }
${extra}
`;

const OPT = (extra = '') => `
const o = { targets: [
  { metricName: 'Memory Recall', weight: 0.25, direction: 'maximize', threshold: 0.7 },
  { metricName: 'Wiring Health', weight: 0.12, direction: 'maximize', threshold: 0.8 },
${extra}
] };
`;

const MANIFEST = (over: Partial<ParityManifest> = {}): ParityManifest => ({
  intentionalExclusions: [{ name: 'Eval-Integrity', reason: 'weight-0 tripwire' }],
  acceptedWeightDivergences: [],
  ...over,
});

describe('parity — eval-production metric-surface parity (ZOU-277)', () => {
  describe('static extraction', () => {
    test('scorecard surface = name + weight from buildMetric calls, with file:line evidence', () => {
      const { metrics } = extractScorecardSurface({ source: PROD(), label: 'collector.ts' });
      const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));
      expect(byName['Memory Recall'].weight).toBeCloseTo(0.25, 9);
      expect(byName['Wiring Health'].weight).toBeCloseTo(0.12, 9);
      expect(byName['Eval-Integrity'].weight).toBe(0);
      expect(byName['Memory Recall'].evidence).toMatch(/^collector\.ts:\d+$/);
    });

    test('optimizer surface = metricName + weight from objective targets', () => {
      const metrics = extractOptimizerSurface({ source: OPT(), label: 'multi-metric.ts' });
      const names = metrics.map((m) => m.name).sort();
      expect(names).toEqual(['Memory Recall', 'Wiring Health']);
      expect(metrics.find((m) => m.name === 'Memory Recall')!.evidence).toMatch(
        /^multi-metric\.ts:\d+$/
      );
    });

    test('a metric declared with conflicting weights is an inconsistent_weight defect', () => {
      const src = PROD(
        `async function dup() { return buildMetric('Memory Recall', 0.9, 0.85, 0.7, 0.20, 'd', 'r'); }`
      );
      const { inconsistencies } = extractScorecardSurface({ source: src, label: 'collector.ts' });
      expect(inconsistencies.map((f) => f.metric)).toContain('Memory Recall');
      expect(inconsistencies[0].kind).toBe('inconsistent_weight');
    });
  });

  describe('scanMetricParity — asymmetry detection', () => {
    test('agreeing surfaces (allowlisted tripwire) produce zero findings', () => {
      const report = scanMetricParity({
        productionSource: PROD(),
        optimizerSource: OPT(),
        manifest: MANIFEST(),
      });
      expect(report.findings).toEqual([]);
      expect(report.aligned).toBe(report.declared);
    });

    test('a metric measured but not optimized (not allowlisted) → only_in_production', () => {
      const src = PROD(
        `async function c() { return buildMetric('Chunk Health', 0.9, 0.85, 0.7, 0.08, 'd', 'r'); }`
      );
      const report = scanMetricParity({
        productionSource: src,
        optimizerSource: OPT(),
        manifest: MANIFEST(),
      });
      const f = report.findings.find((x) => x.metric === 'Chunk Health');
      expect(f?.kind).toBe('only_in_production');
      expect(f?.evidence).toMatch(/collector\.ts:\d+/);
    });

    test('allowlisting that metric suppresses the finding', () => {
      const src = PROD(
        `async function c() { return buildMetric('Chunk Health', 0.9, 0.85, 0.7, 0.08, 'd', 'r'); }`
      );
      const report = scanMetricParity({
        productionSource: src,
        optimizerSource: OPT(),
        manifest: MANIFEST({
          intentionalExclusions: [
            { name: 'Eval-Integrity', reason: 'tripwire' },
            { name: 'Chunk Health', reason: 'not yet optimized' },
          ],
        }),
      });
      expect(report.findings).toEqual([]);
    });

    test('an optimizer target with no production collector → only_in_optimizer (phantom)', () => {
      const opt = OPT(
        `, { metricName: 'Phantom Metric', weight: 0.1, direction: 'maximize', threshold: 0.5 }`
      );
      const report = scanMetricParity({
        productionSource: PROD(),
        optimizerSource: opt,
        manifest: MANIFEST(),
      });
      const f = report.findings.find((x) => x.metric === 'Phantom Metric');
      expect(f?.kind).toBe('only_in_optimizer');
    });

    test('same metric, divergent weight, not accepted → weight_mismatch', () => {
      // optimizer Memory Recall weight 0.20 vs production 0.25
      const opt = `
const o = { targets: [
  { metricName: 'Memory Recall', weight: 0.20, direction: 'maximize', threshold: 0.7 },
  { metricName: 'Wiring Health', weight: 0.12, direction: 'maximize', threshold: 0.8 },
] };`;
      const report = scanMetricParity({
        productionSource: PROD(),
        optimizerSource: opt,
        manifest: MANIFEST(),
      });
      const f = report.findings.find((x) => x.metric === 'Memory Recall');
      expect(f?.kind).toBe('weight_mismatch');
      expect(f?.evidence).toContain('0.25');
      expect(f?.evidence).toContain('0.2');
    });

    test('recording the divergence as accepted suppresses weight_mismatch', () => {
      const opt = `
const o = { targets: [
  { metricName: 'Memory Recall', weight: 0.20, direction: 'maximize', threshold: 0.7 },
  { metricName: 'Wiring Health', weight: 0.12, direction: 'maximize', threshold: 0.8 },
] };`;
      const report = scanMetricParity({
        productionSource: PROD(),
        optimizerSource: opt,
        manifest: MANIFEST({
          acceptedWeightDivergences: [
            { name: 'Memory Recall', scorecardWeight: 0.25, optimizerWeight: 0.2, reason: 'locked' },
          ],
        }),
      });
      expect(report.findings).toEqual([]);
    });

    test('a stale accepted divergence (weights changed) still trips', () => {
      const opt = `
const o = { targets: [
  { metricName: 'Memory Recall', weight: 0.18, direction: 'maximize', threshold: 0.7 },
  { metricName: 'Wiring Health', weight: 0.12, direction: 'maximize', threshold: 0.8 },
] };`;
      const report = scanMetricParity({
        productionSource: PROD(),
        optimizerSource: opt,
        manifest: MANIFEST({
          acceptedWeightDivergences: [
            { name: 'Memory Recall', scorecardWeight: 0.25, optimizerWeight: 0.2, reason: 'stale' },
          ],
        }),
      });
      expect(report.findings.find((x) => x.metric === 'Memory Recall')?.kind).toBe('weight_mismatch');
    });
  });

  describe('CI gate — real production + optimizer surfaces agree', () => {
    test('scanMetricParity over the real source has zero findings', () => {
      // Reads collector.ts + multi-metric.ts + parity-manifest.json from disk. A future PR
      // that adds/removes/reweights a metric on one surface without the other (or the
      // manifest) flips this red with file:line evidence — parity trips automatically.
      const report = scanMetricParity();
      expect(report.findings).toEqual([]);
      expect(report.declared).toBeGreaterThan(0);
    });

    test('every real optimizer target has a real production collector (no phantom targets)', () => {
      const prod = new Set(extractScorecardSurface().metrics.map((m) => m.name));
      for (const t of extractOptimizerSurface()) {
        expect(prod.has(t.name)).toBe(true);
      }
    });
  });
});
