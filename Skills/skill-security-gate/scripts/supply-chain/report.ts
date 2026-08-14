/**
 * Report builder / renderer / writer for the supply-chain checks.
 * buildReport is pure; renderReport is pure; only writeReport touches fs.
 */

import type { Category, Finding, SupplyChainReport } from './types.js';
import { summarize } from './types.js';

export function buildReport(checksRun: Category[], findings: Finding[]): SupplyChainReport {
  const summary = summarize(findings);
  return {
    check: 'supply-chain',
    timestamp: new Date().toISOString(),
    checksRun,
    findings,
    summary,
    passed: summary.critical === 0,
  };
}

const ICON: Record<Finding['severity'], string> = { critical: '✖', warning: '▲', info: 'ℹ' };

export function renderReport(report: SupplyChainReport): string {
  const lines: string[] = [];
  lines.push(`[SUPPLY-CHAIN] checks: ${report.checksRun.join(', ') || '(none)'}`);
  lines.push(
    `  critical=${report.summary.critical}  warning=${report.summary.warning}  info=${report.summary.info}  -> ${report.passed ? 'PASS' : 'FAIL'}`,
  );

  const byCat = (cat: Category) => report.findings.filter((f) => f.category === cat);
  for (const cat of report.checksRun) {
    const fs = byCat(cat);
    lines.push(`\n  ── ${cat} (${fs.length}) ──`);
    if (fs.length === 0) {
      lines.push(`     (no findings)`);
      continue;
    }
    for (const f of fs) {
      lines.push(`     ${ICON[f.severity]} [${f.severity}] ${f.target}`);
      lines.push(`        ${f.finding}`);
      lines.push(`        evidence: ${f.evidence}`);
      lines.push(`        fix: ${f.remediation}`);
    }
  }
  return lines.join('\n');
}

export function writeReport(report: SupplyChainReport, dir: string, id?: string): string {
  const { mkdirSync, writeFileSync } = require('fs');
  const { join } = require('path');
  mkdirSync(dir, { recursive: true });
  const stamp = id ?? report.timestamp.replace(/[:.]/g, '-');
  const path = join(dir, `supply-chain-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8');
  return path;
}
