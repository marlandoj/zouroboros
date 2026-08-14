/**
 * Governor for self-prescription safety
 */

import { existsSync } from 'fs';
import { Database } from 'bun:sqlite';
import { getMemoryDbPath } from 'zouroboros-core';
import { DIVERGENCE_TOLERANCE } from '../introspect/holdout.js';
import type { Playbook, GovernorReport, MetricResult } from '../types.js';

const RAG_FAITHFULNESS_THRESHOLD = 0.70;

function latestRAGFaithfulness(): number | null {
  const dbPath = getMemoryDbPath();
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query(
      `SELECT value FROM facts WHERE key='rag_health_score' ORDER BY created_at DESC LIMIT 1`
    ).get() as { value: string } | null;
    if (!row) return null;
    const score = parseFloat(row.value);
    return isNaN(score) ? null : score;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function evaluatePrescription(
  playbook: Playbook,
  metric: MetricResult
): GovernorReport {
  const flags: string[] = [];
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

  // Governor rule 1: Schema migration check
  if (playbook.id.includes('schema') || playbook.targetFile?.includes('migration')) {
    flags.push('Touches database schema migrations');
    riskLevel = 'HIGH';
  }

  // Governor rule 2: File count check
  if (playbook.maxFiles > 3) {
    flags.push(`Modifies ${playbook.maxFiles} files (>3 threshold)`);
    if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM';
  }

  // Governor rule 3: Executor bridge changes
  if (playbook.targetFile?.includes('bridge') || playbook.targetFile?.includes('executor')) {
    flags.push('Modifies executor bridges');
    riskLevel = 'HIGH';
  }

  // Governor rule 4: Critical metric with low baseline
  if (metric.status === 'CRITICAL' && metric.value < 0.3) {
    flags.push('Critical metric with very low baseline');
    if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM';
  }

  // Governor rule 5: Already approved by playbook definition
  if (playbook.requiresApproval) {
    flags.push(playbook.approvalReason || 'Requires explicit approval');
    riskLevel = 'HIGH';
  }

  // Governor rule 6: RAG faithfulness gate (M10-t2)
  // Block autonomous evolution if the retrieval layer is producing unfaithful
  // outputs — the prescription seed cannot be trusted in that state.
  const ragScore = latestRAGFaithfulness();
  if (ragScore !== null && ragScore < RAG_FAITHFULNESS_THRESHOLD) {
    flags.push(
      `RAG faithfulness ${(ragScore * 100).toFixed(1)}% below ${(RAG_FAITHFULNESS_THRESHOLD * 100).toFixed(0)}% threshold`
    );
    if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM';
  }

  const approved = flags.length === 0;

  return {
    approved,
    flags,
    riskLevel,
    requiresHuman: !approved,
    reason: approved
      ? 'Prescription approved for autonomous execution'
      : `Governor flags: ${flags.join('; ')}`,
  };
}

/**
 * Anti-Goodhart post-flight gate (seed-antigoodhart-wiring-2026-06-01, E1 / AC-E1.4).
 *
 * Distinct from evaluatePrescription, which is a PRE-flight gate keyed on (playbook, metric).
 * evaluateDrift runs AFTER an evolution and judges the held-out divergence the evolve
 * post-flight computed: when the VISIBLE composite rose while the HIDDEN held-out bank did
 * not (divergence > tolerance), the change is Goodhart drift and must be escalated to a
 * human before it is trusted — the loop cannot clear its own tripwire.
 *
 * This function only returns the GovernorReport struct; it sends no email. User-facing
 * delivery is handled by the existing daily-agent evolution report (which already emails
 * outcomes) reading the persisted goodhartFlag / drift fields off the evolution result.
 */
export function evaluateDrift(
  divergence: number,
  tolerance: number = DIVERGENCE_TOLERANCE
): GovernorReport {
  const pct = (divergence * 100).toFixed(1);
  const tolPct = (tolerance * 100).toFixed(0);

  if (divergence <= tolerance) {
    return {
      approved: true,
      flags: [],
      riskLevel: 'LOW',
      requiresHuman: false,
      reason: `Held-out divergence ${pct}% within tolerance ${tolPct}% — visible and hidden evals agree`,
    };
  }

  return {
    approved: false,
    flags: [`Anti-Goodhart tripwire: held-out divergence ${pct}% exceeds tolerance ${tolPct}%`],
    riskLevel: 'HIGH',
    requiresHuman: true,
    reason:
      `Goodhart drift detected: the visible composite improved while the hidden held-out bank did ` +
      `not (divergence ${pct}% > tolerance ${tolPct}%). The evolution is NOT trusted and requires ` +
      `human review before it can be accepted.`,
  };
}