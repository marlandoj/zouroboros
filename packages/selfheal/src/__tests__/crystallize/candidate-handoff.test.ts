import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvolutionResult, Prescription } from '../../types.js';
import {
  buildEvolutionCandidateBundle,
  isEligibleEvolution,
} from '../../crystallize/candidate-handoff.js';
import { orchestrateEvolutionBundle } from '../../crystallize/orchestrate.js';
import { approveCandidate } from '../../crystallize/approve.js';
import { freshCrystallizationsDb } from './_helpers.js';

const prescription: Prescription = {
  id: 'rx-503',
  timestamp: '2026-07-11T00:00:00.000Z',
  metric: {
    name: 'skill_effectiveness', value: 0.5, target: 0.8, critical: 0.3,
    weight: 1, score: 0.5, status: 'WARNING', trend: '—', detail: '', recommendation: '',
  },
  playbook: {
    id: 'graduate-skill', name: 'Graduate successful procedure', description: '',
    targetFile: null, metricCommand: 'echo 0.8', metricDirection: 'higher_is_better',
    constraints: [], maxFiles: 2, requiresApproval: false,
  },
  seed: '',
  program: null,
  governor: { approved: true, flags: [], riskLevel: 'LOW', requiresHuman: false, reason: 'ok' },
};

const result: EvolutionResult = {
  prescriptionId: prescription.id,
  success: true,
  baseline: { composite: 0.5, metrics: [] },
  postFlight: { composite: 0.8, metrics: [] },
  delta: 0.3,
  reverted: false,
  detail: 'kept',
  processReward: 1,
};

let tmp = '';
let skillsRoot = '';
let db: Database;
let priorSecret: string | undefined;

describe('governed evolve candidate handoff', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'evolve-candidate-'));
    skillsRoot = join(tmp, 'Skills');
    mkdirSync(skillsRoot, { recursive: true });
    db = freshCrystallizationsDb();
    priorSecret = process.env.CRYSTALLIZE_APPROVAL_SECRET;
    process.env.CRYSTALLIZE_APPROVAL_SECRET = 'a'.repeat(32);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    if (priorSecret === undefined) delete process.env.CRYSTALLIZE_APPROVAL_SECRET;
    else process.env.CRYSTALLIZE_APPROVAL_SECRET = priorSecret;
  });

  test('eligibility rejects reverted, unmeasured, or weak trajectories', () => {
    expect(isEligibleEvolution(prescription, result)).toBe(true);
    expect(isEligibleEvolution(prescription, { ...result, reverted: true })).toBe(false);
    expect(isEligibleEvolution(prescription, { ...result, postFlight: null })).toBe(false);
    expect(isEligibleEvolution(prescription, { ...result, processReward: 0.79 })).toBe(false);
  });

  test('builds a deterministic, versioned evidence bundle', () => {
    const a = buildEvolutionCandidateBundle(prescription, result, '2026-07-11T00:00:00.000Z');
    const b = buildEvolutionCandidateBundle(prescription, result, '2026-07-11T00:00:00.000Z');
    expect(a).toEqual(b);
    expect(a.schema_version).toBe('1.0.0');
    expect(a.candidate_version).toMatch(/^1\.0\.0\+[0-9a-f]{12}$/);
    expect(a.files.map((file) => file.path)).toEqual([
      'SKILL.md', 'scripts/run.ts', 'tests/evidence.test.ts', 'lineage.json',
      'cost.json', 'provenance.json', 'candidate-manifest.json',
    ]);
  });

  test('mechanically evaluates once, deduplicates, and requires manual approval', async () => {
    const bundle = buildEvolutionCandidateBundle(prescription, result, '2026-07-11T00:00:00.000Z');
    const sent: unknown[] = [];
    const inputs = {
      db,
      skills_root: skillsRoot,
      projectRoot: tmp,
      knownMcpTools: new Set<string>(),
      bundle,
      sendEmail: async (message: unknown) => { sent.push(message); },
      typecheck: async () => [],
      nowSeconds: 1_700_000_000,
    };
    const first = await orchestrateEvolutionBundle(inputs);
    expect(first.outcome).toBe('drafted');
    expect(first.candidate?.eval_status).toBe('mechanical_only');
    expect(first.candidate?.approval_status).toBe('pending');
    expect(sent).toHaveLength(1);
    expect(existsSync(join(skillsRoot, bundle.slug))).toBe(false);
    expect(existsSync(join(skillsRoot, '_candidates', bundle.slug, 'candidate-manifest.json'))).toBe(true);

    const second = await orchestrateEvolutionBundle(inputs);
    expect(second.outcome).toBe('deduplicated');

    const approved = approveCandidate({
      db, skills_root: skillsRoot, id: first.candidate!.id,
      token: first.candidate!.token_for_test_only!, nowSeconds: 1_700_000_001,
    });
    expect(approved.ok).toBe(true);
    expect(existsSync(join(skillsRoot, bundle.slug, 'SKILL.md'))).toBe(true);
    const promoted = db.prepare(
      `SELECT payload FROM crystallization_events
        WHERE crystallization_id=? AND event_type='promoted' ORDER BY id DESC LIMIT 1`,
    ).get(first.candidate!.id) as { payload: string };
    expect(JSON.parse(promoted.payload)).toMatchObject({
      observation: 'reuse_survivability', reuse_count: 0, surviving: true,
      candidate_version: bundle.candidate_version,
    });
    expect(JSON.parse(readFileSync(join(skillsRoot, bundle.slug, 'provenance.json'), 'utf8')).result_hash)
      .toBe(bundle.provenance.result_hash);
  });
});
