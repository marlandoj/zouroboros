import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupplyChainReport } from './types.js';

export interface SupplyChainAttestation {
  schemaVersion: 1;
  check: 'supply-chain';
  generatedAt: string;
  reportPassed: boolean;
  summary: SupplyChainReport['summary'];
  checksRun: SupplyChainReport['checksRun'];
  sourceDigest: string;
  reviewRequired: number;
  reportPath: string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sourceDigest(report: SupplyChainReport): string {
  const stable = {
    check: report.check,
    checksRun: [...report.checksRun].sort(),
    findings: [...report.findings].sort((a, b) =>
      `${a.category}:${a.target}:${a.finding}`.localeCompare(`${b.category}:${b.target}:${b.finding}`),
    ),
    summary: report.summary,
    passed: report.passed,
  };
  return `sha256:${createHash('sha256').update(canonical(stable)).digest('hex')}`;
}

export function buildAttestation(report: SupplyChainReport, generatedAt = report.timestamp, reportPath: string | null = null): SupplyChainAttestation {
  return {
    schemaVersion: 1,
    check: 'supply-chain',
    generatedAt,
    reportPassed: report.passed,
    summary: report.summary,
    checksRun: [...report.checksRun].sort(),
    sourceDigest: sourceDigest(report),
    reviewRequired: report.findings.filter((finding) => finding.category === 'mcp-policy' && finding.severity !== 'critical').length,
    reportPath,
  };
}

export function writeAttestation(attestation: SupplyChainAttestation, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const stamp = attestation.generatedAt.replace(/[:.]/g, '-');
  const path = join(dir, `supply-chain-attestation-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' });
  return path;
}
