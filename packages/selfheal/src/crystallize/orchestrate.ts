/**
 * orchestrate.ts — top-level scan→draft→eval→email pipeline.
 *
 * Composition (no new logic — wires the existing seams):
 *   • capacity.checkCapacity      — short-circuit on backpressure
 *   • score.weightSources         — produce candidates from the loaded sources
 *   • slug.resolveSlugCollision   — collision-suffix the slug
 *   • draft.draftCandidate        — LLM-author SKILL.md + emit stub scripts
 *   • static-scan + grep-validate via eval-mechanical
 *   • eval-replay (mechanical_only fallback when no trace exists)
 *   • DB writes — single crystallizations row + crystallization_events trail
 *   • hmac.signToken              — token for the approval CLI
 *   • email.composeApprovalEmail  — plain-text body
 *   • email sender (injected)     — production CLI passes the Zo email tool
 *
 * Per seed AC: a single function returns a deterministic, observable result
 * the CLI can render to stdout AND the test suite can assert against.
 */

import type { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { weightSources, type ScoreInputs } from './score.js';
import { resolveSlugCollision } from './slug.js';
import { draftCandidate, type LlmDriver, type TraceToolCall } from './draft.js';
import {
  evaluateMechanical,
  type TypeCheckDriver,
} from './eval-mechanical.js';
import { checkCapacity } from './capacity.js';
import { composeApprovalEmail, type EmailSender } from './email.js';
import { signToken, tokenPrefix8 } from './hmac.js';
import { LlmCostCapExceededError } from './llm-draft.js';
import {
  APPROVAL_TTL_DAYS,
  PENDING_CAPACITY_CEILING,
  type Candidate,
  type EventType,
  type SourceKind,
  type TriggerKind,
  type EvolutionCandidateBundle,
} from './types.js';

export interface OrchestrateInputs {
  /** Memory DB handle (where crystallizations + crystallization_events live). */
  db: Database;
  /** Skills/ root — both Skills/_candidates/ and Skills/<slug>/ live here. */
  skills_root: string;
  /** Source rows already loaded (production CLI loads these from DB). */
  sources: ScoreInputs;
  /** Trigger that invoked this run. */
  trigger: TriggerKind;
  /** Cold-start window from caller (drives threshold). */
  coldStart: boolean;
  /** LLM driver for draft.ts (real adapter from llm-draft.ts; tests stub it). */
  llm: LlmDriver;
  /** Tool calls per candidate slug — already extracted from recorded traces. */
  toolCallsBySlug?: Map<string, TraceToolCall[]>;
  /** Email sender (production CLI passes a real Zo email adapter). */
  sendEmail: EmailSender;
  /** Optional capacity ceiling override (tests). */
  capacityCeiling?: number;
  /** Project root passed to mechanical eval's grep-validate (typically /home/workspace). */
  projectRoot: string;
  /** Known MCP tools (passed through to grep-validate). */
  knownMcpTools: Set<string>;
  /** Mechanical eval typecheck driver (tests inject a deterministic stub). */
  typecheck?: TypeCheckDriver;
  /** Override for `now` (unix seconds). */
  nowSeconds?: number;
  /** Optional local replay gate. null means no fixture exists for this candidate. */
  replayEvaluator?: (candidate: {
    id: string;
    slug: string;
    draftPath: string;
    sourceIds: string[];
  }) => Promise<{
    status: 'replay_pass' | 'replay_fail';
    payload?: Record<string, unknown>;
  } | null>;
}

export interface OrchestrateResult {
  /** What happened, in coarse buckets, so the CLI can choose an exit code. */
  outcome:
    | 'no_candidates'
    | 'capacity_backpressure'
    | 'drafted'
    | 'all_failed_eval'
    | 'cost_capped';
  /** One entry per candidate processed. */
  candidates: ProcessedCandidate[];
  pending_count: number;
  /** Set when outcome === 'cost_capped'. */
  cost_cap_detail?: { spent_today_usd: number; cap_usd: number };
}

export interface ProcessedCandidate {
  id: string;
  slug: string;
  source_kind: SourceKind;
  weighted_score: number;
  draft_path: string;
  eval_status:
    | 'mechanical_pass'
    | 'mechanical_fail'
    | 'replay_pass'
    | 'replay_fail'
    | 'mechanical_only';
  approval_status: 'pending' | 'rejected';
  email_sent: boolean;
  /** Set only on success; full token never logged elsewhere. */
  token_for_test_only?: string;
}

export interface EvolutionBundleInputs {
  db: Database;
  skills_root: string;
  projectRoot: string;
  knownMcpTools: Set<string>;
  bundle: EvolutionCandidateBundle;
  sendEmail: EmailSender;
  typecheck?: TypeCheckDriver;
  nowSeconds?: number;
}

export interface EvolutionBundleResult {
  outcome: 'drafted' | 'deduplicated' | 'mechanical_fail' | 'capacity_backpressure';
  candidate: ProcessedCandidate | null;
}

function newId(): string {
  return randomUUID();
}

function sourceSignature(c: Candidate): string {
  return c.source_signature;
}

export async function orchestrateEvolutionBundle(
  i: EvolutionBundleInputs,
): Promise<EvolutionBundleResult> {
  const cap = checkCapacity(i.db, PENDING_CAPACITY_CEILING);
  if (!cap.ok) return { outcome: 'capacity_backpressure', candidate: null };
  if (i.db.prepare(`SELECT id FROM crystallizations WHERE source_signature = ? LIMIT 1`).get(i.bundle.source_signature)) {
    return { outcome: 'deduplicated', candidate: null };
  }

  const now = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  const candidatesRoot = join(i.skills_root, '_candidates');
  mkdirSync(candidatesRoot, { recursive: true });
  const slug = resolveSlugCollision(i.bundle.slug, {
    candidatesRoot,
    promotedRoot: i.skills_root,
  });
  const draftDir = join(candidatesRoot, slug);
  writeDraftedFiles(draftDir, i.bundle.files);
  const id = newId();
  const expiresAt = now + APPROVAL_TTL_DAYS * 86_400;
  insertCrystallization(i.db, {
    id,
    slug,
    source_kind: 'procedure',
    source_ids: JSON.stringify(i.bundle.source_ids),
    source_signature: i.bundle.source_signature,
    weighted_score: i.bundle.weighted_score,
    draft_path: draftDir,
    trigger_kind: 'event_hook',
    llm_cost_usd: 0,
    created_at: now,
    expires_at: expiresAt,
  });
  appendEvent(i.db, id, 'created', {
    schema_version: i.bundle.schema_version,
    candidate_version: i.bundle.candidate_version,
    playbook_id: i.bundle.playbook_id,
    provenance: i.bundle.provenance,
  });

  const mech = await evaluateMechanical(
    { slug, files: i.bundle.files, llm_cost_usd: 0 },
    {
      projectRoot: i.projectRoot,
      knownMcpTools: i.knownMcpTools,
      typecheck: i.typecheck,
    },
  );
  appendEvent(i.db, id, 'mechanical_eval', {
    status: mech.status,
    failures: mech.failures,
    candidate_version: i.bundle.candidate_version,
  });
  if (mech.status === 'mechanical_fail') {
    i.db.prepare(
      `UPDATE crystallizations SET eval_status='mechanical_fail', approval_status='rejected', evaluated_at=? WHERE id=?`,
    ).run(now, id);
    return {
      outcome: 'mechanical_fail',
      candidate: {
        id, slug, source_kind: 'procedure', weighted_score: i.bundle.weighted_score,
        draft_path: draftDir, eval_status: 'mechanical_fail', approval_status: 'rejected', email_sent: false,
      },
    };
  }

  i.db.prepare(`UPDATE crystallizations SET eval_status='mechanical_only', evaluated_at=? WHERE id=?`).run(now, id);
  const token = signToken({ id, created_at: now, candidate_path: draftDir });
  i.db.prepare(`UPDATE crystallizations SET approval_token_prefix_8=? WHERE id=?`).run(tokenPrefix8(token), id);
  let emailSent = false;
  try {
    const msg = composeApprovalEmail({
      id, slug, candidate_path: draftDir, source_ids: i.bundle.source_ids,
      source_kind: 'procedure', weighted_score: i.bundle.weighted_score,
      eval_status: 'mechanical_only', created_at: now, ttl_days: APPROVAL_TTL_DAYS, token,
    });
    await i.sendEmail(msg);
    emailSent = true;
    appendEvent(i.db, id, 'email_sent', { content_type: msg.content_type });
  } catch (err) {
    appendEvent(i.db, id, 'email_sent', { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return {
    outcome: 'drafted',
    candidate: {
      id, slug, source_kind: 'procedure', weighted_score: i.bundle.weighted_score,
      draft_path: draftDir, eval_status: 'mechanical_only', approval_status: 'pending',
      email_sent: emailSent, token_for_test_only: token,
    },
  };
}

export async function orchestrateScan(
  i: OrchestrateInputs,
): Promise<OrchestrateResult> {
  const now = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  const candidates: ProcessedCandidate[] = [];

  const cap = checkCapacity(
    i.db,
    i.capacityCeiling ?? PENDING_CAPACITY_CEILING,
  );
  if (!cap.ok) {
    return {
      outcome: 'capacity_backpressure',
      candidates: [],
      pending_count: cap.pending_count,
    };
  }

  const matched = weightSources(i.sources);

  if (matched.length === 0) {
    return { outcome: 'no_candidates', candidates: [], pending_count: cap.pending_count };
  }

  const candidatesRoot = join(i.skills_root, '_candidates');
  mkdirSync(candidatesRoot, { recursive: true });

  // Idempotency: skip a candidate whose source_signature already has a row.
  const existsStmt = i.db.prepare(
    `SELECT id FROM crystallizations WHERE source_signature = ? LIMIT 1`,
  );

  for (const candidate of matched) {
    const sig = sourceSignature(candidate);
    if (existsStmt.get(sig)) {
      continue;
    }

    const slug = resolveSlugCollision(candidate.slug_suggestion, {
      candidatesRoot,
      promotedRoot: i.skills_root,
    });

    const toolCalls = i.toolCallsBySlug?.get(candidate.slug_suggestion) ?? [];
    let drafted;
    try {
      drafted = await draftCandidate(candidate, {
        slug,
        toolCalls,
        llm: i.llm,
      });
    } catch (err) {
      if (err instanceof LlmCostCapExceededError) {
        return {
          outcome: 'cost_capped',
          candidates,
          pending_count: cap.pending_count,
          cost_cap_detail: {
            spent_today_usd: err.spent_today_before,
            cap_usd: err.cap_usd,
          },
        };
      }
      throw err;
    }

    const draftDir = join(candidatesRoot, slug);
    writeDraftedFiles(draftDir, drafted.files);

    const id = newId();
    const expiresAt = now + APPROVAL_TTL_DAYS * 86_400;

    insertCrystallization(i.db, {
      id,
      slug,
      source_kind: candidate.source_kind,
      source_ids: JSON.stringify(candidate.sources.map((s) => s.id)),
      source_signature: sig,
      weighted_score: candidate.score,
      draft_path: draftDir,
      trigger_kind: i.trigger,
      llm_cost_usd: drafted.llm_cost_usd,
      created_at: now,
      expires_at: expiresAt,
    });

    appendEvent(i.db, id, 'created', {
      source_count: candidate.sources.length,
    });

    const mech = await evaluateMechanical(
      { slug, files: drafted.files, llm_cost_usd: drafted.llm_cost_usd },
      {
        projectRoot: i.projectRoot,
        knownMcpTools: i.knownMcpTools,
        typecheck: i.typecheck,
      },
    );

    appendEvent(i.db, id, 'mechanical_eval', {
      status: mech.status,
      failures: mech.failures,
    });

    if (mech.status === 'mechanical_fail') {
      i.db.prepare(
        `UPDATE crystallizations
            SET eval_status = 'mechanical_fail',
                approval_status = 'rejected',
                evaluated_at = ?
          WHERE id = ?`,
      ).run(now, id);
      candidates.push({
        id,
        slug,
        source_kind: candidate.source_kind,
        weighted_score: candidate.score,
        draft_path: draftDir,
        eval_status: 'mechanical_fail',
        approval_status: 'rejected',
        email_sent: false,
      });
      continue;
    }

    let evalStatus: ProcessedCandidate['eval_status'] = 'mechanical_only';
    if (i.replayEvaluator) {
      try {
        const replay = await i.replayEvaluator({
          id,
          slug,
          draftPath: draftDir,
          sourceIds: candidate.sources.map((source) => source.id),
        });
        if (replay) {
          evalStatus = replay.status;
          appendEvent(i.db, id, 'replay_eval', {
            status: replay.status,
            ...(replay.payload ?? {}),
          });
        } else {
          appendEvent(i.db, id, 'replay_eval', {
            status: 'mechanical_only',
            reason: 'no_matching_replay_fixture',
          });
        }
      } catch (error) {
        evalStatus = 'replay_fail';
        appendEvent(i.db, id, 'replay_eval', {
          status: 'replay_fail',
          reason: 'replay_evaluator_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (evalStatus === 'replay_fail') {
      i.db.prepare(
        `UPDATE crystallizations
            SET eval_status = 'replay_fail',
                approval_status = 'rejected',
                evaluated_at = ?
          WHERE id = ?`,
      ).run(now, id);
      candidates.push({
        id,
        slug,
        source_kind: candidate.source_kind,
        weighted_score: candidate.score,
        draft_path: draftDir,
        eval_status: 'replay_fail',
        approval_status: 'rejected',
        email_sent: false,
      });
      continue;
    }

    i.db.prepare(
      `UPDATE crystallizations
          SET eval_status = ?,
              evaluated_at = ?
        WHERE id = ?`,
    ).run(evalStatus, now, id);

    const token = signToken({
      id,
      created_at: now,
      candidate_path: draftDir,
    });
    i.db.prepare(
      `UPDATE crystallizations
          SET approval_token_prefix_8 = ?
        WHERE id = ?`,
    ).run(tokenPrefix8(token), id);

    let emailSent = false;
    try {
      const msg = composeApprovalEmail({
        id,
        slug,
        candidate_path: draftDir,
        source_ids: candidate.sources.map((s) => s.id),
        source_kind: candidate.source_kind,
        weighted_score: candidate.score,
        eval_status: evalStatus,
        created_at: now,
        ttl_days: APPROVAL_TTL_DAYS,
        token,
      });
      await i.sendEmail(msg);
      emailSent = true;
      appendEvent(i.db, id, 'email_sent', { content_type: msg.content_type });
    } catch (err) {
      appendEvent(i.db, id, 'email_sent', {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    candidates.push({
      id,
      slug,
      source_kind: candidate.source_kind,
      weighted_score: candidate.score,
      draft_path: draftDir,
      eval_status: evalStatus,
      approval_status: 'pending',
      email_sent: emailSent,
      token_for_test_only: token,
    });
  }

  const allFailed = candidates.length > 0 && candidates.every((c) => c.approval_status === 'rejected');
  const updatedCap = checkCapacity(i.db, i.capacityCeiling ?? PENDING_CAPACITY_CEILING);

  return {
    outcome: candidates.length === 0
      ? 'no_candidates'
      : allFailed
      ? 'all_failed_eval'
      : 'drafted',
    candidates,
    pending_count: updatedCap.pending_count,
  };
}

function writeDraftedFiles(
  dir: string,
  files: { path: string; content: string }[],
): void {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const target = join(dir, f.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, f.content);
  }
}

interface InsertRow {
  id: string;
  slug: string;
  source_kind: SourceKind;
  source_ids: string;
  source_signature: string;
  weighted_score: number;
  draft_path: string;
  trigger_kind: TriggerKind;
  llm_cost_usd: number;
  created_at: number;
  expires_at: number;
}

function insertCrystallization(db: Database, r: InsertRow): void {
  db.prepare(
    `INSERT INTO crystallizations
       (id, slug, source_kind, source_ids, source_signature, weighted_score,
        draft_path, trigger_kind, llm_cost_usd, created_at, expires_at,
        eval_status, approval_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
  ).run(
    r.id,
    r.slug,
    r.source_kind,
    r.source_ids,
    r.source_signature,
    r.weighted_score,
    r.draft_path,
    r.trigger_kind,
    r.llm_cost_usd,
    r.created_at,
    r.expires_at,
  );
}

function appendEvent(
  db: Database,
  crystallization_id: string,
  event_type: EventType,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO crystallization_events (crystallization_id, event_type, payload)
     VALUES (?, ?, ?)`,
  ).run(crystallization_id, event_type, JSON.stringify(payload));
}

// Approve / reject transitions live in approve.ts so cli/crystallize.ts can
// wire them without re-importing the full orchestration surface.
