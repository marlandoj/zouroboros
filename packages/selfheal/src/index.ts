/**
 * Zouroboros Self-Heal
 *
 * Self-diagnostic, prescription, and evolution system for autonomous improvement.
 *
 * @module zouroboros-selfheal
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { DEFAULT_CONFIG, getMemoryDbPath, getWorkspaceRoot } from 'zouroboros-core';
import { createEpisode, init as initMemory, shutdown as shutdownMemory } from 'zouroboros-memory';
import { buildScorecard, formatScorecard } from './introspect/scorecard.js';
import { getPlaybook } from './prescribe/playbook.js';
import { evaluatePrescription } from './prescribe/governor.js';
import { generateSeed, generateProgram } from './prescribe/seed.js';
import { runSelfHealPlanGateShadow } from './prescribe/plan-gate.js';
import { executeEvolution } from './evolve/executor.js';
import { expectedStateChange } from './evolve/intervention-ledger.js';
import type { Scorecard, Prescription, EvolutionResult } from './types.js';

export const VERSION = '2.0.0';

export * from './types.js';
export * from './introspect/scorecard.js';
export * from './prescribe/playbook.js';
export * from './prescribe/governor.js';
export * from './prescribe/seed.js';
export * from './prescribe/plan-gate.js';
export * from './evolve/executor.js';
export * from './evolve/regime-gate.js';
export * from './evolve/strategy-md.js';
export * from './evolve/intervention-ledger.js';
export * from './evolve/tool-reflections.js';
export * from './evolve/execution-validator.js';
export * from './feedback.js';
export * from './multi-metric.js';
export * from './templates.js';
export * from './history.js';
export * from './replay/cassette.js';
export * from './replay/recorder.js';
export * from './replay/regression.js';
export * from './prescribe/plan-gate.js';
export * as planGate from './prescribe/plan-gate.js';

export interface IntrospectOptions {
  json?: boolean;
  store?: boolean;
  verbose?: boolean;
}

export interface PrescribeOptions {
  scorecard?: string;
  live?: boolean;
  target?: string;
}

export interface EvolveOptions {
  prescription?: string;
  dryRun?: boolean;
  skipGovernor?: boolean;
}

const RESULTS_DIR = join(getWorkspaceRoot(), '.zo/selfheal');

async function storeEpisode(input: {
  summary: string;
  outcome: 'success' | 'failure' | 'resolved' | 'ongoing';
  entities: string[];
  metadata?: Record<string, unknown>;
  durationMs?: number;
}): Promise<void> {
  const dbPath = getMemoryDbPath();
  if (!dbPath) return;

  let initialized = false;
  try {
    initMemory({
      ...DEFAULT_CONFIG.memory,
      dbPath,
      autoCapture: false,
      vectorEnabled: false,
    });
    initialized = true;
    createEpisode(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[selfheal] episode persistence failed: ${message}`);
  } finally {
    if (initialized) shutdownMemory();
  }
}

function scorecardEpisode(scorecard: Scorecard): {
  summary: string;
  metadata: Record<string, unknown>;
} {
  return {
    summary: [
      `Zouroboros introspection scorecard: composite ${(scorecard.composite * 100).toFixed(1)}%.`,
      `Weakest: ${scorecard.weakest}.`,
      scorecard.topOpportunities.length > 0
        ? `Top opportunity: ${scorecard.topOpportunities[0]!.metric}.`
        : 'All optimized metrics healthy.',
    ].join(' '),
    metadata: {
      composite: scorecard.composite,
      weakest: scorecard.weakest,
      metrics: scorecard.metrics,
      topOpportunities: scorecard.topOpportunities,
    },
  };
}

export class SelfHeal {
  async introspect(options: IntrospectOptions = {}): Promise<Scorecard> {
    const scorecard = await buildScorecard();

    if (options.verbose) {
      console.log(formatScorecard(scorecard));
    }

    if (options.json) {
      console.log(JSON.stringify(scorecard, null, 2));
    }

    if (options.store) {
      mkdirSync(RESULTS_DIR, { recursive: true });
      const path = join(RESULTS_DIR, `scorecard-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(scorecard, null, 2));

      // Write a searchable fact so future RAG Health evaluations have domain context
      const memDb = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
      if (memDb) {
        const dateStr = new Date().toISOString().slice(0, 10);
        const factId = `zouroboros-scorecard-${dateStr}`;
        const metricsObj: Record<string, string> = {};
        for (const m of scorecard.metrics) {
          metricsObj[m.name] = `${(m.value * 100).toFixed(1)}% (${m.status})`;
        }
        const value = JSON.stringify({
          date: dateStr,
          composite: (scorecard.composite * 100).toFixed(1),
          weakest: scorecard.weakest,
          metrics: metricsObj,
        });
        try {
          const { Database } = await import('bun:sqlite');
          const db = new Database(memDb);
          try {
            db.query(
              `INSERT OR REPLACE INTO facts(id,persona,entity,key,value,category,decay_class) VALUES(?,?,?,?,?,?,?)`
            ).run(factId, 'introspect', 'zouroboros.introspection', `scorecard-${dateStr}`, value, 'metric', 'stable');
          } finally {
            db.close();
          }
        } catch { /* best-effort */ }
      }

      const episode = scorecardEpisode(scorecard);
      await storeEpisode({
        ...episode,
        outcome: scorecard.composite >= 0.9 ? 'success' : 'ongoing',
        entities: ['zouroboros.introspection'],
      });
    }

    return scorecard;
  }

  async prescribe(options: PrescribeOptions = {}): Promise<Prescription> {
    // Load or build scorecard
    let scorecard: Scorecard;
    if (options.scorecard) {
      scorecard = JSON.parse(readFileSync(options.scorecard, 'utf-8'));
    } else {
      scorecard = await buildScorecard();
    }

    // Find the target metric (weakest by default)
    const targetName = options.target || scorecard.weakest;
    const metric = scorecard.metrics.find(m => m.name === targetName) || scorecard.metrics[0];

    const playbook = getPlaybook(metric);
    const governor = evaluatePrescription(playbook, metric);

    // ZOU-280: consult the intervention ledger for this playbook's causal history so the
    // seed carries expected state-changes (composite + collateral movers + prior drift),
    // not just the correlational metric→playbook mapping. null when no history yet.
    const stateChange = expectedStateChange(playbook.id);

    const seed = generateSeed(playbook, metric, stateChange);
    const program = generateProgram(playbook, metric);

    const prescription: Prescription = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      metric,
      playbook,
      seed,
      program,
      governor,
      expectedStateChange: stateChange,
      planGateShadow: runSelfHealPlanGateShadow({
        seed,
        title: `Self-heal plan for ${metric.name}`,
        taskTitle: playbook.name,
        legacy: {
          status: governor.approved ? 'passed' : 'rejected',
          pass: governor.approved,
          detail: governor.reason,
        },
      }),
    };

    await storeEpisode({
      summary: `Zouroboros prescription ${prescription.id}: ${playbook.name} for ${metric.name} (${metric.status}, score ${(metric.score * 100).toFixed(1)}%). Governor: ${governor.approved ? 'approved' : 'blocked'}.`,
      outcome: 'ongoing',
      entities: ['zouroboros.prescription', `zouroboros.${metric.name.toLowerCase().replace(/\s+/g, '-')}`],
      metadata: {
        prescriptionId: prescription.id,
        metric,
        playbook,
        governor,
      },
    });

    return prescription;
  }

  async evolve(options: EvolveOptions = {}): Promise<EvolutionResult> {
    let prescription: Prescription;
    if (options.prescription) {
      prescription = JSON.parse(readFileSync(options.prescription, 'utf-8'));
    } else {
      prescription = await this.prescribe();
    }

    const result = await executeEvolution(prescription, {
      dryRun: options.dryRun,
      skipGovernor: options.skipGovernor,
    });

    await storeEpisode({
      summary: `Zouroboros evolution ${prescription.id}: ${prescription.playbook.name} ${result.success ? 'succeeded' : 'failed'} for ${prescription.metric.name}; delta ${(result.delta * 100).toFixed(1)} percentage points.`,
      outcome: result.success ? 'success' : 'failure',
      entities: ['zouroboros.evolution', `zouroboros.${prescription.metric.name.toLowerCase().replace(/\s+/g, '-')}`],
      metadata: {
        prescriptionId: prescription.id,
        playbook: prescription.playbook,
        result,
      },
    });

    return result;
  }
}

const _defaultInstance = new SelfHeal();

export async function introspect(options: IntrospectOptions = {}): Promise<Scorecard> {
  return _defaultInstance.introspect(options);
}

export async function prescribe(options: PrescribeOptions = {}): Promise<Prescription> {
  return _defaultInstance.prescribe(options);
}

export async function evolve(options: EvolveOptions = {}): Promise<EvolutionResult> {
  return _defaultInstance.evolve(options);
}
