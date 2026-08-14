/**
 * Calibrated competence boundary (ZOU-281, #4 of the Intelligence-Harness roadmap).
 *
 * The consensus gate reads vendor (multi-model) disagreement as a confidence signal: a
 * unanimous PASS is trusted, a split is escalated. But that read is only meaningful where
 * the gate has *seen enough* of a domain to know what normal disagreement looks like. On a
 * brand-new domain with two prior decisions, a 50/50 split is noise, not signal — yet the
 * raw gate would treat it identically to a 50/50 split in a domain with 200 calibrated
 * priors. That is the classic thin-evidence trap: a confident dispatch built on a sample
 * too small to calibrate.
 *
 * This module ports the introspect/prescribe ADVISORY-tier sample-discipline (n≥20 gate →
 * renormalize the signal → flag thin history) onto the consensus layer, so the gate surfaces
 * "I don't have enough history here to judge whether this disagreement is meaningful" as an
 * explicit UNCALIBRATED/PROVISIONAL band rather than a falsely-confident verdict.
 *
 * The three bands mirror the ADVISORY tier exactly:
 *   - CALIBRATED   (n ≥ calibratedThreshold, default 20): full trust, signal unscaled.
 *   - PROVISIONAL  (meaningfulThreshold ≤ n < calibratedThreshold): disagreement is
 *                  observable but not yet calibrated → down-weighted, thin-history flag,
 *                  advisory.
 *   - UNCALIBRATED (n < meaningfulThreshold, default 5): too few priors for vendor
 *                  disagreement to be meaningful at all → heavily down-weighted, advisory.
 *
 * "Renormalize" = scale the raw disagreement by calibratedConfidence (= n / threshold,
 * capped at 1) so thin evidence cannot drive a decision — the consensus analogue of the
 * introspect step that renormalizes an ADVISORY metric out of the composite.
 *
 * Pure compute (computeCompetenceBand / countDomainHistory / disagreementFromConsensus) is
 * IO-free and unit-tested; loadConsensusHistory is the only fs touchpoint and reads the same
 * `~/.zouroboros/consensus-gate.json` array the consensus-gate skill persists.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from 'zouroboros-core';

/** Default minimum prior decisions in a domain for the disagreement read to be fully trusted. */
export const CALIBRATED_THRESHOLD = 20;
/** Default minimum prior decisions below which vendor disagreement is not yet meaningful. */
export const MEANINGFUL_THRESHOLD = 5;

export type CompetenceBand = 'CALIBRATED' | 'PROVISIONAL' | 'UNCALIBRATED';

export interface CompetenceConfig {
  /** n ≥ this → CALIBRATED (full trust). Default {@link CALIBRATED_THRESHOLD}. */
  calibratedThreshold: number;
  /** n < this → UNCALIBRATED (disagreement not meaningful). Default {@link MEANINGFUL_THRESHOLD}. */
  meaningfulThreshold: number;
}

export const DEFAULT_COMPETENCE_CONFIG: CompetenceConfig = {
  calibratedThreshold: CALIBRATED_THRESHOLD,
  meaningfulThreshold: MEANINGFUL_THRESHOLD,
};

export interface CompetenceReport {
  /** The domain key this band was computed for (consensus `criteria`, e.g. "correctness,security"). */
  domain: string;
  /** Count of prior gate decisions seen in this domain. */
  domainHistoryCount: number;
  band: CompetenceBand;
  /**
   * How much to trust the disagreement read given history: min(1, n / calibratedThreshold).
   * 1.0 at/above the gate; shrinks linearly toward 0 as history thins.
   */
  calibratedConfidence: number;
  /** True when n is below the calibrated gate — the "📊 thin-history" flag. */
  thinHistory: boolean;
  /** True when the band must not drive a confident dispatch on its own (PROVISIONAL | UNCALIBRATED). */
  advisory: boolean;
  /** The disagreement signal as observed (0 = unanimous, 1 = maximally split). */
  rawDisagreement: number;
  /**
   * The renormalized signal: rawDisagreement × calibratedConfidence. Thin history shrinks
   * the signal toward 0 so it cannot drive a decision; at full calibration it equals raw.
   */
  effectiveDisagreement: number;
  /** Human-readable, prefixed with 📊 when thinHistory. */
  note: string;
}

/** The minimal shape of a persisted consensus decision this module reads. */
export interface ConsensusLike {
  criteria?: string;
  label?: string;
  consensus?: { unanimous?: boolean; pass?: boolean; confidence?: number };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Derive the raw disagreement signal (0..1) from a consensus block. A unanimous verdict is
 * zero disagreement regardless of confidence; otherwise disagreement is 1 − confidence so a
 * low-confidence split reads as high disagreement. Missing confidence is treated as fully
 * uncertain (disagreement 1) when not unanimous.
 */
export function disagreementFromConsensus(
  consensus: ConsensusLike['consensus'] | undefined
): number {
  if (!consensus) return 0;
  if (consensus.unanimous) return 0;
  const confidence = typeof consensus.confidence === 'number' ? clamp01(consensus.confidence) : 0;
  return clamp01(1 - confidence);
}

/**
 * Count prior decisions in a domain across a persisted history array. `dimension` selects
 * which field is the domain key — `criteria` (the gate's substantive domain, default) or
 * `label`. Matching is exact on the trimmed string; records missing the field are skipped.
 */
export function countDomainHistory(
  records: ConsensusLike[],
  domain: string,
  dimension: 'criteria' | 'label' = 'criteria'
): number {
  const want = domain.trim();
  let n = 0;
  for (const r of records) {
    const key = (r?.[dimension] ?? '').toString().trim();
    if (key && key === want) n++;
  }
  return n;
}

/**
 * Compute the competence band for a single gate decision in `domain`, given how many prior
 * decisions the gate has seen there and the raw disagreement of the current decision.
 *
 * This is the heart of ZOU-281: the n≥20 gate (calibratedThreshold), the renormalize step
 * (effectiveDisagreement = raw × calibratedConfidence), and the thin-history flag — the same
 * sample-discipline the introspect ADVISORY tier applies to its metrics, applied here so the
 * consensus gate cannot confidently dispatch on a domain it has not yet calibrated.
 */
export function computeCompetenceBand(
  domain: string,
  domainHistoryCount: number,
  rawDisagreement: number,
  config: CompetenceConfig = DEFAULT_COMPETENCE_CONFIG
): CompetenceReport {
  const n = Math.max(0, Math.floor(domainHistoryCount));
  const { calibratedThreshold, meaningfulThreshold } = config;
  const raw = clamp01(rawDisagreement);

  const calibratedConfidence = clamp01(calibratedThreshold > 0 ? n / calibratedThreshold : 1);
  const effectiveDisagreement = clamp01(raw * calibratedConfidence);

  let band: CompetenceBand;
  if (n >= calibratedThreshold) band = 'CALIBRATED';
  else if (n >= meaningfulThreshold) band = 'PROVISIONAL';
  else band = 'UNCALIBRATED';

  const thinHistory = n < calibratedThreshold;
  const advisory = band !== 'CALIBRATED';

  let note: string;
  if (band === 'CALIBRATED') {
    note = `${n} prior decisions in "${domain}" — disagreement read is calibrated.`;
  } else if (band === 'PROVISIONAL') {
    note =
      `📊 only ${n} prior decisions in "${domain}" (need ${calibratedThreshold} to calibrate) — ` +
      `disagreement observable but down-weighted ×${calibratedConfidence.toFixed(2)}; treat as advisory.`;
  } else {
    note =
      `📊 only ${n} prior decisions in "${domain}" (< ${meaningfulThreshold}) — ` +
      `too thin for vendor disagreement to be meaningful; signal heavily down-weighted, advisory only.`;
  }

  return {
    domain,
    domainHistoryCount: n,
    band,
    calibratedConfidence,
    thinHistory,
    advisory,
    rawDisagreement: raw,
    effectiveDisagreement,
    note,
  };
}

/** One-line human summary of a competence report (📊-prefixed via the report note). */
export function formatCompetenceReport(report: CompetenceReport): string {
  return (
    `[${report.band}] ${report.domain}: n=${report.domainHistoryCount} ` +
    `conf=${report.calibratedConfidence.toFixed(2)} ` +
    `raw=${report.rawDisagreement.toFixed(2)} eff=${report.effectiveDisagreement.toFixed(2)} — ${report.note}`
  );
}

/**
 * Resolve the consensus-gate history file. Honors `CONSENSUS_GATE_DB`; otherwise falls back
 * to `<dataDir>/consensus-gate.json` — the same array the consensus-gate skill writes.
 */
export function consensusHistoryPath(explicit?: string): string {
  return explicit || process.env.CONSENSUS_GATE_DB || join(getDataDir(), 'consensus-gate.json');
}

/**
 * Load the persisted consensus history array. Returns [] when the file is absent or
 * malformed (fail-safe: a missing history reads as zero priors → UNCALIBRATED, never throws).
 */
export function loadConsensusHistory(path?: string): ConsensusLike[] {
  const file = consensusHistoryPath(path);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as ConsensusLike[]) : [];
  } catch {
    return [];
  }
}

/**
 * End-to-end convenience: given a domain key and the current decision's consensus block,
 * load history, count priors, and return the competence band. The single entrypoint a caller
 * (the consensus-gate skill, via the standalone runner) needs to annotate a verdict.
 */
export function calibrateConsensusDecision(
  domain: string,
  consensus: ConsensusLike['consensus'] | undefined,
  opts: { historyPath?: string; records?: ConsensusLike[]; config?: CompetenceConfig } = {}
): CompetenceReport {
  const records = opts.records ?? loadConsensusHistory(opts.historyPath);
  const n = countDomainHistory(records, domain);
  const raw = disagreementFromConsensus(consensus);
  return computeCompetenceBand(domain, n, raw, opts.config);
}
