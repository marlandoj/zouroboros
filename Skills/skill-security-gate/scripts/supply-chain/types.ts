/**
 * Shared types for the supply-chain checks (action-pin-audit, mcp-inject-scan,
 * mcp-inventory). All three emit the same categorized Finding shape so one report
 * writer/renderer serves all of them.
 */

export type Severity = 'critical' | 'warning' | 'info';

export type Category = 'action-pin' | 'mcp-inject' | 'mcp-policy';

export interface Finding {
  /** What was scanned — a workflow ref, an MCP server id, etc. */
  target: string;
  category: Category;
  severity: Severity;
  /** One-line human summary of the issue. */
  finding: string;
  /** The concrete evidence (file:line, the offending text, the classification). */
  evidence: string;
  /** What the operator should do about it. */
  remediation: string;
}

export interface SupplyChainReport {
  check: 'supply-chain';
  timestamp: string;
  checksRun: Category[];
  findings: Finding[];
  summary: { critical: number; warning: number; info: number };
  /** passed = no critical findings. */
  passed: boolean;
}

export function summarize(findings: Finding[]): SupplyChainReport['summary'] {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}
