import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMemoryDbPath, getWorkspaceRoot } from 'zouroboros-core';
import type { EvolutionResult, Prescription } from '../types.js';
import { buildEvolutionCandidateBundle, isEligibleEvolution } from './candidate-handoff.js';
import { orchestrateEvolutionBundle } from './orchestrate.js';
import type { EmailMessage } from './email.js';

export type RuntimeHandoffResult = {
  outcome: 'ineligible' | 'unavailable' | 'drafted' | 'deduplicated' | 'mechanical_fail' | 'capacity_backpressure';
  candidate_id?: string;
};

export async function handoffEvolutionCandidate(
  prescription: Prescription,
  result: EvolutionResult,
): Promise<RuntimeHandoffResult> {
  if (process.env.SELFHEAL_EVOLVE_CRYSTALLIZE === '0' || !isEligibleEvolution(prescription, result)) {
    return { outcome: 'ineligible' };
  }
  if (!process.env.CRYSTALLIZE_APPROVAL_SECRET) return { outcome: 'unavailable' };

  const workspace = getWorkspaceRoot();
  const skillsRoot = process.env.ZOUROBOROS_SKILLS_ROOT ?? join(workspace, 'Skills');
  const dbPath = getMemoryDbPath();
  if (!existsSync(skillsRoot) || !existsSync(dbPath)) return { outcome: 'unavailable' };
  const db = new Database(dbPath);
  try {
    const schema = db.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name IN ('crystallizations', 'crystallization_events')`,
    ).get() as { count: number };
    if (schema.count !== 2) return { outcome: 'unavailable' };
    const queueRoot = join(skillsRoot, '_candidates', '_email-queue');
    const sendEmail = async (message: EmailMessage): Promise<void> => {
      mkdirSync(queueRoot, { recursive: true });
      const id = message.body.split('\n').find((line) => line.startsWith('id:'))?.slice(3).trim() ?? 'unknown';
      const target = join(queueRoot, `${id}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(message, null, 2));
    };
    const orchestrated = await orchestrateEvolutionBundle({
      db,
      skills_root: skillsRoot,
      projectRoot: workspace,
      knownMcpTools: new Set(),
      bundle: buildEvolutionCandidateBundle(prescription, result),
      sendEmail,
    });
    return {
      outcome: orchestrated.outcome,
      candidate_id: orchestrated.candidate?.id,
    };
  } finally {
    db.close();
  }
}
