import { test, expect, describe } from 'bun:test';
import { buildReport, renderReport } from './report.js';
import type { Finding } from './types.js';

const crit: Finding = {
  target: 'ci.yml:19',
  category: 'action-pin',
  severity: 'critical',
  finding: 'mutable ref',
  evidence: 'uses: actions/checkout@v4',
  remediation: 'pin to sha',
};
const info: Finding = {
  target: 'memory',
  category: 'mcp-policy',
  severity: 'info',
  finding: 'unlisted',
  evidence: '.mcp.json [package/third-party]',
  remediation: 'add to policy',
};

describe('buildReport', () => {
  test('passed is false when a critical is present', () => {
    const r = buildReport(['action-pin'], [crit]);
    expect(r.passed).toBe(false);
    expect(r.summary).toEqual({ critical: 1, warning: 0, info: 0 });
  });

  test('passed is true with only info/warning', () => {
    const r = buildReport(['mcp-policy'], [info]);
    expect(r.passed).toBe(true);
    expect(r.summary.info).toBe(1);
  });

  test('empty findings => passed', () => {
    const r = buildReport(['action-pin', 'mcp-policy'], []);
    expect(r.passed).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});

describe('renderReport', () => {
  test('renders PASS/FAIL banner and per-category blocks', () => {
    const out = renderReport(buildReport(['action-pin', 'mcp-policy'], [crit, info]));
    expect(out).toContain('[SUPPLY-CHAIN]');
    expect(out).toContain('-> FAIL');
    expect(out).toContain('action-pin');
    expect(out).toContain('mcp-policy');
    expect(out).toContain('ci.yml:19');
  });

  test('shows "(no findings)" for a clean category', () => {
    const out = renderReport(buildReport(['action-pin'], []));
    expect(out).toContain('(no findings)');
    expect(out).toContain('-> PASS');
  });
});
