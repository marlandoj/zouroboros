import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { EvolutionResult, Prescription } from '../types.js';
import { slugify } from './slug.js';
import {
  EVOLUTION_BUNDLE_SCHEMA_VERSION,
  type EvolutionCandidateBundle,
} from './types.js';

const MIN_PROCESS_REWARD = 0.8;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function isEligibleEvolution(
  prescription: Prescription,
  result: EvolutionResult,
): boolean {
  if (!prescription.governor.approved || prescription.governor.requiresHuman) return false;
  if (!result.success || result.reverted || result.postFlight === null) return false;
  if ((result.processReward ?? 0) < MIN_PROCESS_REWARD) return false;
  return prescription.playbook.metricDirection === 'higher_is_better'
    ? result.delta > 0
    : result.delta < 0;
}

export function buildEvolutionCandidateBundle(
  prescription: Prescription,
  result: EvolutionResult,
  generatedAt = new Date().toISOString(),
): EvolutionCandidateBundle {
  const resultHash = sha256({
    playbook_id: prescription.playbook.id,
    metric_name: prescription.metric.name,
    baseline: result.baseline,
    post_flight: result.postFlight,
    delta: result.delta,
    process_reward: result.processReward,
  });
  const sourceSignature = sha256({
    playbook_id: prescription.playbook.id,
    result_hash: resultHash,
  });
  const baseSlug = (slugify(prescription.playbook.name) || 'evolved-procedure')
    .slice(0, 39)
    .replace(/-+$/, '');
  const slug = `${baseSlug}-${resultHash.slice(0, 8)}`;
  const candidateVersion = `1.0.0+${resultHash.slice(0, 12)}`;
  const provenance = {
    prescription_id: prescription.id,
    metric_name: prescription.metric.name,
    result_hash: resultHash,
    generated_at: generatedAt,
  };

  const skillMd = `---
name: ${slug}
description: Candidate procedure distilled from a governed Zouroboros evolution.
metadata:
  version: ${candidateVersion}
  source: evolve
---

# ${prescription.playbook.name}

## When to invoke
- When the ${prescription.metric.name} improvement pattern recurs.
- After an operator has reviewed and approved this candidate.

## Inputs
- The task context required by the approved playbook.

## Outputs
- A reproducible execution result with recorded evidence.
`;
  const glue = `export const candidateVersion = '${candidateVersion}';
export const playbookId = '${prescription.playbook.id.replaceAll("'", '')}';

export async function run(): Promise<never> {
  throw new Error('Candidate glue requires manual implementation before promotion');
}
`;
  const lineage = {
    schema_version: EVOLUTION_BUNDLE_SCHEMA_VERSION,
    candidate_version: candidateVersion,
    playbook_id: prescription.playbook.id,
    prescription_id: prescription.id,
    strategy_lineage: {
      metric: prescription.metric.name,
      baseline: result.baseline.composite,
      post_flight: result.postFlight?.composite ?? null,
      delta: result.delta,
      process_reward: result.processReward ?? null,
    },
  };
  const cost = {
    schema_version: EVOLUTION_BUNDLE_SCHEMA_VERSION,
    measured_llm_cost_usd: 0,
    accounting: 'evolve executor does not currently expose token cost',
  };
  const test = `import { describe, expect, test } from 'bun:test';
import { candidateVersion, playbookId } from '../scripts/run.js';

describe('candidate evidence', () => {
  test('pins version and playbook lineage', () => {
    expect(candidateVersion).toBe('${candidateVersion}');
    expect(playbookId).toBe('${prescription.playbook.id.replaceAll("'", '')}');
  });
});
`;
  const manifest = {
    schema_version: EVOLUTION_BUNDLE_SCHEMA_VERSION,
    candidate_version: candidateVersion,
    source_signature: sourceSignature,
    files: [
      'SKILL.md',
      'scripts/run.ts',
      'tests/evidence.test.ts',
      'lineage.json',
      'cost.json',
      'provenance.json',
      'candidate-manifest.json',
    ],
  };

  return {
    schema_version: EVOLUTION_BUNDLE_SCHEMA_VERSION,
    candidate_version: candidateVersion,
    slug,
    playbook_id: prescription.playbook.id,
    source_signature: sourceSignature,
    weighted_score: result.processReward ?? 0,
    source_ids: [prescription.playbook.id, prescription.id],
    provenance,
    files: [
      { path: 'SKILL.md', content: skillMd },
      { path: 'scripts/run.ts', content: glue },
      { path: 'tests/evidence.test.ts', content: test },
      { path: 'lineage.json', content: JSON.stringify(lineage, null, 2) + '\n' },
      { path: 'cost.json', content: JSON.stringify(cost, null, 2) + '\n' },
      { path: 'provenance.json', content: JSON.stringify(provenance, null, 2) + '\n' },
      { path: 'candidate-manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' },
    ],
  };
}

export interface PromotionHealth {
  candidate_version: string | null;
  reuse_count: number;
  successful_reuse_count: number;
  reuse_success_rate: number | null;
  surviving: boolean;
  observed_at: number;
}

export function recordPromotionHealth(inputs: {
  db: Database;
  crystallization_id: string;
  slug: string;
  promoted_path: string;
  nowSeconds?: number;
}): PromotionHealth {
  const observedAt = inputs.nowSeconds ?? Math.floor(Date.now() / 1000);
  const table = inputs.db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='skill_executions'`)
    .get() as { ok: number } | undefined;
  let reuseCount = 0;
  let successfulReuseCount = 0;
  if (table) {
    const row = inputs.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes
           FROM skill_executions
          WHERE skill = ?`,
      )
      .get(inputs.slug) as { total: number; successes: number | null };
    reuseCount = row.total;
    successfulReuseCount = row.successes ?? 0;
  }
  let candidateVersion: string | null = null;
  const manifestPath = `${inputs.promoted_path}/candidate-manifest.json`;
  if (existsSync(manifestPath)) {
    try {
      candidateVersion = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { candidate_version?: string })
        .candidate_version ?? null;
    } catch {
      candidateVersion = null;
    }
  }
  const health: PromotionHealth = {
    candidate_version: candidateVersion,
    reuse_count: reuseCount,
    successful_reuse_count: successfulReuseCount,
    reuse_success_rate: reuseCount > 0 ? successfulReuseCount / reuseCount : null,
    surviving: existsSync(`${inputs.promoted_path}/SKILL.md`),
    observed_at: observedAt,
  };
  return health;
}
