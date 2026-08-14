/**
 * weightSources — clusters successful sources and emits weighted candidates.
 *
 * Per seed:
 *   - procedures           weight 1.0
 *   - episodes (success|resolved)  weight 0.4
 *   - skill_executions (success)   weight 0.5
 *   - threshold ≥ 3.0 normal, ≥ 2.0 in cold-start window (first 30 days)
 *
 * v1 clustering is intentionally simple: one candidate per source row that, on
 * its own or in a same-name pair (procedure name match for procedures;
 * skill_name for skill_executions), crosses the threshold. Episodes are grouped
 * by entity link when available, else treated as a single bucket. Mixed-kind
 * clusters are produced when the bucket spans more than one source kind.
 *
 * The seed's stronger semantic clustering (e.g. tool-call shape similarity) is
 * deferred to v2. v1's job is to produce *some* candidates, not *the best*.
 */

import { createHash } from 'crypto';
import {
  Candidate,
  ScoringConfig,
  SourceKind,
  SourceRow,
  DEFAULT_WEIGHTS,
  NORMAL_THRESHOLD,
  COLD_START_THRESHOLD,
} from './types.js';
import { normalizeSourceSlug } from './slug.js';

export interface ScoreInputs {
  procedures: SourceRow[];
  episodes: SourceRow[];
  skillExecutions: SourceRow[];
  /** Whether we're inside the 30-day cold-start window. */
  coldStart: boolean;
}

export function defaultConfig(coldStart: boolean): ScoringConfig {
  return {
    threshold: coldStart ? COLD_START_THRESHOLD : NORMAL_THRESHOLD,
    weights: { ...DEFAULT_WEIGHTS },
  };
}

function weightOf(row: SourceRow, weights: ScoringConfig['weights']): number {
  switch (row.kind) {
    case 'procedure':
      return weights.procedure;
    case 'episode':
      return weights.episode;
    case 'skill_execution':
      return weights.skill_execution;
  }
}

function clusterKey(row: SourceRow): string {
  switch (row.kind) {
    case 'procedure':
      return `procedure:${row.name}`;
    case 'skill_execution':
      return `skill:${row.skill_name}`;
    case 'episode':
      // No stable cluster key for episodes pre-v2; group by leading word in
      // summary so semantically-similar runs aggregate.
      return `episode:${(row.summary.split(/\s+/)[0] ?? 'misc').toLowerCase()}`;
  }
}

function deriveSourceKind(rows: SourceRow[]): SourceKind {
  const kinds = new Set(rows.map((r) => r.kind));
  if (kinds.size > 1) return 'mixed';
  return [...kinds][0]!;
}

function signatureOf(rows: SourceRow[]): string {
  const ids = rows.map((r) => r.id).sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex');
}

function slugFromCluster(rows: SourceRow[]): string {
  // Prefer procedure or skill name over episode summary.
  const proc = rows.find((r) => r.kind === 'procedure');
  if (proc && proc.kind === 'procedure') return normalizeSourceSlug(proc.name);
  const skill = rows.find((r) => r.kind === 'skill_execution');
  if (skill && skill.kind === 'skill_execution') return normalizeSourceSlug(skill.skill_name);
  // Fall back to first episode's leading two summary tokens.
  const ep = rows.find((r) => r.kind === 'episode');
  if (ep && ep.kind === 'episode') return normalizeSourceSlug(ep.summary.split(/\s+/).slice(0, 2).join(' '));
  return 'crystallized';
}

export function weightSources(
  inputs: ScoreInputs,
  config: ScoringConfig = defaultConfig(inputs.coldStart),
): Candidate[] {
  const all: SourceRow[] = [
    ...inputs.procedures,
    ...inputs.episodes,
    ...inputs.skillExecutions,
  ];

  const buckets = new Map<string, SourceRow[]>();
  for (const row of all) {
    const key = clusterKey(row);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  const candidates: Candidate[] = [];
  for (const rows of buckets.values()) {
    const score = rows.reduce(
      (sum, r) => sum + weightOf(r, config.weights),
      0,
    );
    if (score < config.threshold) continue;

    candidates.push({
      sources: rows,
      score,
      source_kind: deriveSourceKind(rows),
      source_signature: signatureOf(rows),
      slug_suggestion: slugFromCluster(rows),
    });
  }

  // Highest-score first — eval cap (3/scan from seed) consumes from the top.
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
