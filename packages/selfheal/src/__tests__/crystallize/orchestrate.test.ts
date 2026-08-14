/**
 * orchestrateScan — the wiring test.
 *
 * Asserts (with stub LLM + stub email sender):
 *   • happy path drafts one candidate, mech-eval passes, email sent, row in
 *     pending+mechanical_only, token prefix recorded
 *   • capacity backpressure short-circuits BEFORE LLM is called (FX-22 wiring)
 *   • idempotent rerun: a second invocation with the same source returns
 *     no_candidates because source_signature already exists
 *   • email-send failure is captured as an event but does NOT roll back the row
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { freshCrystallizationsDb } from './_helpers.js';
import { orchestrateScan } from '../../crystallize/orchestrate.js';
import type { ScoreInputs } from '../../crystallize/score.js';
import type { LlmDriver } from '../../crystallize/draft.js';
import type { EmailMessage, EmailSender } from '../../crystallize/email.js';
import { LlmCostCapExceededError } from '../../crystallize/llm-draft.js';

const ENV_KEY = 'CRYSTALLIZE_APPROVAL_SECRET';
let savedSecret: string | undefined;
let tmp = '';
let skillsRoot = '';
let db: Database;

function makeStubLlm(content: string): LlmDriver {
  return async () => ({ content, cost_usd: 0.01 });
}

function makeStubSender(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = async (msg) => {
    sent.push(msg);
  };
  return { sender, sent };
}

function makeStubFailingSender(): EmailSender {
  return async () => {
    throw new Error('smtp down');
  };
}

const baseSources = (count = 3): ScoreInputs => ({
  procedures: Array.from({ length: count }, (_, i) => ({
    kind: 'procedure' as const,
    id: `proc-${i + 1}`,
    name: 'deploy-zo-route',
    steps: [],
    success_count: 5 + i,
    failure_count: 0,
  })),
  episodes: [],
  skillExecutions: [],
  coldStart: false,
});

const SKILL_MD_OK = `---
name: deploy-zo-route
description: Deploy a Zo route given a path.
---

# deploy-zo-route

## When to invoke
- After the route handler is authored.

## Inputs
- route handler

## Outputs
- live route
`;

describe('crystallize/orchestrate', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cryst-orch-'));
    skillsRoot = join(tmp, 'Skills');
    mkdirSync(skillsRoot, { recursive: true });
    db = freshCrystallizationsDb();
    savedSecret = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'a'.repeat(32);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    if (savedSecret === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedSecret;
  });

  test('happy path drafts, mech-evals, emails, persists pending row', async () => {
    const llm = makeStubLlm(SKILL_MD_OK);
    const { sender, sent } = makeStubSender();

    const r = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources: baseSources(3),
      trigger: 'manual',
      coldStart: false,
      llm,
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
    });

    expect(r.outcome).toBe('drafted');
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.eval_status).toBe('mechanical_only');
    expect(c.approval_status).toBe('pending');
    expect(c.email_sent).toBe(true);
    expect(c.token_for_test_only).toMatch(/^[0-9a-f]{64}$/);

    expect(existsSync(c.draft_path)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].content_type).toBe('text/plain; charset=utf-8');

    const row = db
      .prepare(
        `SELECT approval_status, eval_status, approval_token_prefix_8
           FROM crystallizations WHERE id = ?`,
      )
      .get(c.id) as {
        approval_status: string;
        eval_status: string;
        approval_token_prefix_8: string;
      };
    expect(row.approval_status).toBe('pending');
    expect(row.eval_status).toBe('mechanical_only');
    expect(row.approval_token_prefix_8).toBe(c.token_for_test_only!.slice(0, 8));
  });

  test('source-derived names are normalized before mechanical evaluation', async () => {
    const sources = baseSources(3);
    for (const source of sources.procedures) {
      if (source.kind === 'procedure') {
        source.name = 'Swarm swarm_1785076357645-remediation:-2';
      }
    }
    const { sender } = makeStubSender();
    const result = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources,
      trigger: 'manual',
      coldStart: false,
      llm: makeStubLlm(SKILL_MD_OK),
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
    });

    expect(result.outcome).toBe('drafted');
    expect(result.candidates[0]?.slug).toBe('swarm-swarm-1785076357645-remediation-2');
    expect(result.candidates[0]?.eval_status).toBe('mechanical_only');
  });

  test('FX-22 wiring: pending count at ceiling ⇒ capacity_backpressure, no LLM call', async () => {
    let llmCalls = 0;
    const llm: LlmDriver = async () => {
      llmCalls++;
      return { content: SKILL_MD_OK, cost_usd: 0.01 };
    };
    // Seed 5 pending rows directly.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO crystallizations
           (id, slug, source_kind, source_ids, source_signature, weighted_score,
            draft_path, trigger_kind, llm_cost_usd, created_at, expires_at,
            eval_status, approval_status)
         VALUES (?, ?, 'procedure', '[]', ?, 3.0, ?, 'cron', 0, 1700000000, 1701209600, 'pending', 'pending')`,
      ).run(`id-${i}`, `slug-${i}`, `sig-${i}`, `/tmp/skip-${i}`);
    }

    const { sender } = makeStubSender();
    const r = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources: baseSources(3),
      trigger: 'cron',
      coldStart: false,
      llm,
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
    });

    expect(r.outcome).toBe('capacity_backpressure');
    expect(r.candidates).toHaveLength(0);
    expect(r.pending_count).toBe(5);
    expect(llmCalls).toBe(0);
  });

  test('idempotent rerun: same sources ⇒ no_candidates on second invocation', async () => {
    const { sender } = makeStubSender();
    const sources = baseSources(3);

    const a = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources,
      trigger: 'manual',
      coldStart: false,
      llm: makeStubLlm(SKILL_MD_OK),
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
    });
    expect(a.outcome).toBe('drafted');

    const b = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources,
      trigger: 'manual',
      coldStart: false,
      llm: makeStubLlm(SKILL_MD_OK),
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
    });
    expect(b.outcome).toBe('no_candidates');
    expect(b.candidates).toHaveLength(0);
  });

  test('email send failure is captured as an event but row stays pending', async () => {
    const r = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources: baseSources(3),
      trigger: 'manual',
      coldStart: false,
      llm: makeStubLlm(SKILL_MD_OK),
      sendEmail: makeStubFailingSender(),
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
    });

    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.email_sent).toBe(false);
    const row = db
      .prepare(`SELECT approval_status FROM crystallizations WHERE id = ?`)
      .get(c.id) as { approval_status: string };
    expect(row.approval_status).toBe('pending');

    const events = db
      .prepare(
        `SELECT event_type, payload FROM crystallization_events
          WHERE crystallization_id = ? ORDER BY id ASC`,
      )
      .all(c.id) as Array<{ event_type: string; payload: string }>;
    const emailEvent = events.find((e) => e.event_type === 'email_sent');
    expect(emailEvent).toBeDefined();
    const payload = JSON.parse(emailEvent!.payload);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('smtp down');
  });

  test('LlmCostCapExceededError ⇒ outcome=cost_capped, no throw', async () => {
    const llm: LlmDriver = async () => {
      throw new LlmCostCapExceededError(1.05, 1.0);
    };
    const { sender } = makeStubSender();

    const r = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources: baseSources(3),
      trigger: 'cron',
      coldStart: false,
      llm,
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
    });

    expect(r.outcome).toBe('cost_capped');
    expect(r.candidates).toHaveLength(0);
    expect(r.cost_cap_detail).toEqual({ spent_today_usd: 1.05, cap_usd: 1.0 });
  });

  test('matching replay evidence upgrades candidate to replay_pass', async () => {
    const { sender, sent } = makeStubSender();
    const result = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources: baseSources(3),
      trigger: 'cron',
      coldStart: false,
      llm: makeStubLlm(SKILL_MD_OK),
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
      replayEvaluator: async () => ({ status: 'replay_pass', payload: { regression_id: 'fx-replay' } }),
    });

    expect(result.outcome).toBe('drafted');
    expect(result.candidates[0].eval_status).toBe('replay_pass');
    expect(sent).toHaveLength(1);
    const event = db.prepare(
      `SELECT payload FROM crystallization_events WHERE crystallization_id = ? AND event_type = 'replay_eval'`,
    ).get(result.candidates[0].id) as { payload: string };
    expect(JSON.parse(event.payload).regression_id).toBe('fx-replay');
  });

  test('replay failure rejects candidate before approval email', async () => {
    const { sender, sent } = makeStubSender();
    const result = await orchestrateScan({
      db,
      skills_root: skillsRoot,
      sources: baseSources(3),
      trigger: 'cron',
      coldStart: false,
      llm: makeStubLlm(SKILL_MD_OK),
      sendEmail: sender,
      projectRoot: tmp,
      knownMcpTools: new Set(),
      typecheck: async () => [],
      replayEvaluator: async () => ({ status: 'replay_fail', payload: { mismatch: 'tool response' } }),
    });

    expect(result.outcome).toBe('all_failed_eval');
    expect(result.candidates[0].eval_status).toBe('replay_fail');
    expect(result.candidates[0].approval_status).toBe('rejected');
    expect(sent).toHaveLength(0);
  });
});
