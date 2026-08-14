#!/usr/bin/env bun
/**
 * crystallize.ts — Skill Crystallization v1 CLI.
 *
 * Subcommands:
 *   scan     — load sources, weight them, draft candidates, mech-eval, email
 *   approve  — verify token and promote a pending candidate to Skills/<slug>/
 *   reject   — verify token and archive a pending candidate
 *   list     — list pending candidates with eval/approval status
 *   status   — show one candidate's events + payload
 *   expire   — nightly gc: mark expired pending rows + archive their drafts
 *
 * Discipline (per `agent-path-drift-defense` memory):
 *   • Step 0 — preflight: require all referenced scripts/paths/env vars to
 *     resolve before running. A missing module fails fast, not silently.
 *
 * Invocation log:
 *   Every subcommand writes one JSON line to /dev/shm/crystallize.log:
 *     { ts, cmd, id, token_prefix_8, outcome, duration_ms, detail? }
 *   Token prefixes only — never the full hex value.
 *
 * Email delivery:
 *   The Zo email tool (`mcp__zo__send_email_to_user`) is an MCP tool, not a
 *   shell binary. For determinism the CLI queues approval emails to
 *   <skills_root>/_candidates/_email-queue/<id>.txt and writes a single
 *   newline-delimited JSON manifest <id>.json beside it. A downstream
 *   scheduled agent (registered separately) consumes the queue and calls the
 *   MCP tool. Use --email-stdout for local debugging — body goes to stdout
 *   and no queue file is written.
 */
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { getWorkspaceRoot } from 'zouroboros-core';

import {
  approveCandidate,
  rejectCandidate,
  type DecideOutcome,
} from '../crystallize/approve.js';
import { expirePending } from '../crystallize/expire.js';
import { orchestrateScan } from '../crystallize/orchestrate.js';
import { makeRealLlmDriver } from '../crystallize/llm-draft.js';
import {
  composeApprovalEmail,
  type EmailMessage,
  type EmailSender,
} from '../crystallize/email.js';
import { COLD_START_WINDOW_DAYS } from '../crystallize/types.js';
import type { ScoreInputs } from '../crystallize/score.js';
import type {
  EpisodeSource,
  ProcedureSource,
  SkillExecutionSource,
} from '../crystallize/types.js';
import {
  loadReplayRegressionCases,
  runReplayRegressionCase,
} from '../replay/regression.js';

const INVOCATION_LOG = '/dev/shm/crystallize.log';

interface CliEnv {
  memoryDb: string;
  skillsRoot: string;
  projectRoot: string;
  emailQueueDir: string;
  replayCorpus: string;
  knownMcpTools: Set<string>;
}

function logInvocation(entry: Record<string, unknown>): void {
  try {
    appendFileSync(
      INVOCATION_LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    // /dev/shm may be unavailable in some sandboxes — skip silently rather
    // than fail the user-visible command on logging.
  }
}

/** Step 0 preflight — fail fast on any missing path/module/env var. */
function preflight(env: CliEnv, requireSecret: boolean): void {
  const missing: string[] = [];
  if (!existsSync(env.skillsRoot)) missing.push(`skills_root: ${env.skillsRoot}`);
  if (!existsSync(env.projectRoot)) missing.push(`project_root: ${env.projectRoot}`);
  if (requireSecret && !process.env.CRYSTALLIZE_APPROVAL_SECRET) {
    missing.push('env CRYSTALLIZE_APPROVAL_SECRET');
  }
  if (missing.length > 0) {
    console.error('crystallize: preflight failed —');
    for (const m of missing) console.error(`  • ${m}`);
    process.exit(78); // EX_CONFIG
  }
}

function resolveEnv(): CliEnv {
  const projectRoot = resolve(process.env.ZOUROBOROS_PROJECT_ROOT ?? getWorkspaceRoot());
  const skillsRoot = resolve(
    process.env.ZOUROBOROS_SKILLS_ROOT ?? join(projectRoot, 'Skills'),
  );
  const memoryDb = resolve(
    process.env.ZOUROBOROS_MEMORY_DB ??
      join(process.env.HOME ?? '/root', '.zouroboros', 'memory.db'),
  );
  const emailQueueDir = join(skillsRoot, '_candidates', '_email-queue');
  const replayCorpus = resolve(
    process.env.ZOUROBOROS_REPLAY_CORPUS
      ?? join(projectRoot, 'Seeds', 'zouroboros', 'replay'),
  );
  // No external known-tool registry yet — accept any `mcp__*` reference in
  // SKILL.md by treating the tool set as "unrestricted in CLI mode" and
  // letting grep-validate enforce path references. A future iteration can
  // load this from a registry file.
  const knownMcpTools = new Set<string>();
  return { memoryDb, skillsRoot, projectRoot, emailQueueDir, replayCorpus, knownMcpTools };
}

function openDb(path: string): Database {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

/**
 * Apply zouroboros-memory migrations against the target DB before the CLI
 * opens its own connection. Without this, a fresh DB (or one that pre-dates
 * migrations 003+004) is missing the `crystallizations` / `crystallization_events`
 * tables and every subcommand fails with `no such table`.
 *
 * Uses the same runtime-computed specifier trick as `llm-draft.ts` so tsc
 * doesn't try to resolve a cross-package source path during build.
 */
async function ensureSchema(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const specifier = ['..', '..', '..', 'memory', 'src', 'database.js'].join('/');
  const mod: any = await import(specifier);
  mod.runMigrations({ dbPath });
  // runMigrations holds the memory module's singleton handle open; close it
  // so this CLI's `openDb()` can take its own WAL connection without
  // contention.
  if (typeof mod.closeDatabase === 'function') mod.closeDatabase();
}

/** Email queue sender — writes plain-text payload to disk for downstream MCP delivery. */
function makeQueueSender(queueDir: string, id: string): EmailSender {
  return async (msg: EmailMessage) => {
    if (msg.content_type !== 'text/plain; charset=utf-8') {
      throw new Error(`refusing non-plain content_type: ${msg.content_type}`);
    }
    mkdirSync(queueDir, { recursive: true });
    const txtPath = join(queueDir, `${id}.txt`);
    const jsonPath = join(queueDir, `${id}.json`);
    writeFileSync(txtPath, msg.body);
    writeFileSync(
      jsonPath,
      JSON.stringify({
        id,
        subject: msg.subject,
        content_type: msg.content_type,
        body_path: txtPath,
        queued_at: new Date().toISOString(),
      }) + '\n',
    );
  };
}

function makeStdoutSender(): EmailSender {
  return async (msg: EmailMessage) => {
    process.stdout.write(`Subject: ${msg.subject}\n`);
    process.stdout.write(`Content-Type: ${msg.content_type}\n\n`);
    process.stdout.write(msg.body + '\n');
  };
}

function loadSources(db: Database, nowSeconds: number): ScoreInputs {
  const cutoff = nowSeconds - COLD_START_WINDOW_DAYS * 86_400;

  const procedures = (
    db
      .prepare(
        `SELECT id, name, steps, success_count, failure_count
           FROM procedures
          WHERE success_count >= 1`,
      )
      .all() as Array<{
        id: string;
        name: string;
        steps: string;
        success_count: number;
        failure_count: number;
      }>
  ).map<ProcedureSource>((r) => ({
    kind: 'procedure',
    id: r.id,
    name: r.name,
    steps: safeJsonArray(r.steps),
    success_count: r.success_count,
    failure_count: r.failure_count,
  }));

  const episodes = (
    db
      .prepare(
        `SELECT id, summary, outcome, happened_at
           FROM episodes
          WHERE outcome IN ('success', 'resolved')
            AND happened_at >= ?`,
      )
      .all(cutoff) as Array<{
        id: string;
        summary: string;
        outcome: string;
        happened_at: number;
      }>
  ).map<EpisodeSource>((r) => ({
    kind: 'episode',
    id: r.id,
    summary: r.summary,
    outcome: r.outcome === 'success' ? 'success' : 'resolved',
    happened_at: r.happened_at,
  }));

  let skillExecutions: SkillExecutionSource[] = [];
  const tableCheck = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='skill_executions'`,
    )
    .get();
  if (tableCheck) {
    skillExecutions = (
      db
        .prepare(
          `SELECT id, skill, outcome, strftime('%s', created_at) AS happened_at
             FROM skill_executions
            WHERE outcome = 'success'`,
        )
        .all() as Array<{
          id: number | string;
          skill: string;
          outcome: string;
          happened_at: string;
        }>
    ).map<SkillExecutionSource>((r) => ({
      kind: 'skill_execution',
      id: String(r.id),
      skill_name: r.skill,
      outcome: 'success',
      happened_at: Number(r.happened_at) || 0,
    }));
  }

  return {
    procedures,
    episodes,
    skillExecutions,
    coldStart: isColdStart(db, nowSeconds),
  };
}

function safeJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Cold-start window: no prior crystallizations exist, OR the oldest
 * crystallization was created within COLD_START_WINDOW_DAYS.
 */
function isColdStart(db: Database, nowSeconds: number): boolean {
  const r = db
    .prepare(
      `SELECT MIN(created_at) AS first_at, COUNT(*) AS c FROM crystallizations`,
    )
    .get() as { first_at: number | null; c: number };
  if (!r || r.c === 0) return true;
  if (r.first_at === null) return true;
  return nowSeconds - r.first_at < COLD_START_WINDOW_DAYS * 86_400;
}

function help(): never {
  process.stdout.write(`zouroboros-crystallize — Skill Crystallization v1 CLI

USAGE
  bun .../cli/crystallize.ts <command> [options]

COMMANDS
  scan                       Run scan→draft→eval→email pipeline
    --trigger <kind>         cron | event_hook | manual (default: manual)
    --email-stdout           Print email body instead of queuing
    --dry-run                Skip LLM + email; report what *would* happen

  approve <id> --token <hex> Verify token and promote candidate
    --automated              Require eval_status=replay_pass (fail-closed)
  reject  <id> --token <hex> Verify token and archive candidate

  list                       List pending candidates (slug, score, status)
  status <id>                Show events + payload for one row

  expire                     GC nightly: mark expired pending + archive

ENV
  ZOUROBOROS_MEMORY_DB        Memory SQLite path (default: ~/.zouroboros/memory.db)
  ZOUROBOROS_SKILLS_ROOT      Skills/ root          (default: <project>/Skills)
  ZOUROBOROS_PROJECT_ROOT     Project root          (default: $ZOUROBOROS_WORKSPACE, $ZO_WORKSPACE, or cwd)
  CRYSTALLIZE_APPROVAL_SECRET Required for approve/reject (≥32 bytes)

EXIT CODES
  0  ok      | 1  generic failure
  2  invalid args
  64 token verification failed (approve/reject)
  78 preflight failed (EX_CONFIG)
`);
  process.exit(0);
}

async function cmdScan(args: string[], env: CliEnv): Promise<number> {
  const t0 = Date.now();
  const { values } = parseArgs({
    args,
    options: {
      trigger: { type: 'string', default: 'manual' },
      'email-stdout': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    strict: false,
  });

  // --dry-run produces no operator-actionable token, so we mint a placeholder
  // secret if one isn't set. --email-stdout still needs a real, valid token
  // (the human acts on what they see), so the secret remains required there.
  preflight(env, !values['dry-run']);
  if (values['dry-run'] && !process.env.CRYSTALLIZE_APPROVAL_SECRET) {
    process.env.CRYSTALLIZE_APPROVAL_SECRET = 'dry-run-placeholder-secret-32b'.padEnd(32, 'x');
  }

  const trigger = values.trigger as 'cron' | 'event_hook' | 'manual';
  if (!['cron', 'event_hook', 'manual'].includes(trigger)) {
    console.error(`scan: invalid --trigger ${trigger}`);
    return 2;
  }

  const db = openDb(env.memoryDb);
  try {
    const now = Math.floor(Date.now() / 1000);
    const sources = loadSources(db, now);

    const llm = values['dry-run']
      ? async () => ({ content: '<dry-run>', cost_usd: 0 })
      : makeRealLlmDriver({ db });

    const sendEmail: EmailSender = values['email-stdout']
      ? makeStdoutSender()
      : values['dry-run']
      ? async () => undefined
      : (() => {
          // Defer queue dir to per-id sender below.
          let lastSender: EmailSender | null = null;
          return async (msg: EmailMessage) => {
            // Pull candidate id from the body's `id:` line (composeApprovalEmail
            // emits it). Falls back to subject suffix if missing.
            const idLine = msg.body
              .split('\n')
              .find((l) => l.startsWith('id:'));
            const id = idLine
              ? idLine.replace('id:', '').trim()
              : msg.subject.split(/[() ]/).pop() ?? 'unknown';
            lastSender = makeQueueSender(env.emailQueueDir, id);
            await lastSender(msg);
          };
        })();

    const replayCases = loadReplayRegressionCases(env.replayCorpus, 'crystallization');
    const preloadPath = resolve(import.meta.dir, '..', 'replay', 'preload.ts');

    const result = await orchestrateScan({
      db,
      skills_root: env.skillsRoot,
      sources,
      trigger,
      coldStart: sources.coldStart,
      llm,
      sendEmail,
      projectRoot: env.projectRoot,
      knownMcpTools: env.knownMcpTools,
      nowSeconds: now,
      replayEvaluator: replayCases.length === 0
        ? undefined
        : async ({ slug, draftPath }) => {
            const testCase = replayCases.find((candidate) =>
              candidate.id === slug || candidate.metadata?.crystallization_slug === slug
            );
            if (!testCase) return null;
            const candidateEntrypoint = testCase.metadata?.candidate_entrypoint;
            if (typeof candidateEntrypoint !== 'string' || candidateEntrypoint.length === 0) {
              return {
                status: 'replay_fail' as const,
                payload: { reason: 'candidate_entrypoint_missing', regression_id: testCase.id },
              };
            }
            const result = await runReplayRegressionCase(
              {
                ...testCase,
                command: {
                  ...testCase.command,
                  entrypoint: relative(env.projectRoot, join(draftPath, candidateEntrypoint)),
                },
              },
              env.projectRoot,
              preloadPath,
            );
            return {
              status: result.status === 'pass' ? 'replay_pass' as const : 'replay_fail' as const,
              payload: {
                regression_id: testCase.id,
                regression_status: result.status,
                detail: result.detail,
              },
            };
          },
    });

    const duration_ms = Date.now() - t0;
    logInvocation({
      cmd: 'scan',
      outcome: result.outcome,
      pending_count: result.pending_count,
      candidates: result.candidates.length,
      duration_ms,
    });

    process.stdout.write(
      JSON.stringify(
        {
          outcome: result.outcome,
          pending_count: result.pending_count,
          candidates: result.candidates.map((c) => ({
            id: c.id,
            slug: c.slug,
            source_kind: c.source_kind,
            weighted_score: c.weighted_score,
            eval_status: c.eval_status,
            approval_status: c.approval_status,
            email_sent: c.email_sent,
          })),
        },
        null,
        2,
      ) + '\n',
    );

    if (result.outcome === 'capacity_backpressure') return 0;
    if (result.outcome === 'all_failed_eval') return 1;
    return 0;
  } finally {
    db.close();
  }
}

async function cmdApprove(
  positional: string[],
  args: string[],
  env: CliEnv,
  decide: 'approve' | 'reject',
): Promise<number> {
  const t0 = Date.now();
  const id = positional[0];
  if (!id) {
    console.error(`${decide}: missing <id>`);
    return 2;
  }
  const { values } = parseArgs({
    args,
    options: {
      token: { type: 'string' },
      automated: { type: 'boolean', default: false },
    },
    strict: false,
  });
  const token = values.token as string | undefined;
  if (!token) {
    console.error(`${decide}: missing --token`);
    return 2;
  }

  preflight(env, true);

  const db = openDb(env.memoryDb);
  try {
    const fn = decide === 'approve' ? approveCandidate : rejectCandidate;
    const r: DecideOutcome = fn({
      db,
      skills_root: env.skillsRoot,
      id,
      token,
      automated: decide === 'approve' && values.automated === true,
    });

    const duration_ms = Date.now() - t0;
    logInvocation({
      cmd: decide,
      id,
      token_prefix_8: r.token_prefix_8,
      outcome: r.ok ? r.action : `fail:${r.reason}`,
      duration_ms,
    });

    if (!r.ok) {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          reason: r.reason,
          detail: r.detail,
          token_prefix_8: r.token_prefix_8,
        }) + '\n',
      );
      // Token verification failures get a distinct exit code so cron/log
      // analysis can split them from genuine "not found" errors.
      if (
        r.reason === 'token_invalid' ||
        r.reason === 'token_expired' ||
        r.reason === 'token_malformed' ||
        r.reason === 'token_missing_secret'
      ) {
        return 64;
      }
      return 1;
    }

    process.stdout.write(JSON.stringify(r) + '\n');
    return 0;
  } finally {
    db.close();
  }
}

function cmdList(env: CliEnv): number {
  const db = openDb(env.memoryDb);
  try {
    const rows = db
      .prepare(
        `SELECT id, slug, source_kind, weighted_score, eval_status,
                approval_status, created_at, expires_at
           FROM crystallizations
          WHERE approval_status = 'pending'
          ORDER BY created_at DESC`,
      )
      .all();
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    logInvocation({ cmd: 'list', count: rows.length });
    return 0;
  } finally {
    db.close();
  }
}

function cmdStatus(positional: string[], env: CliEnv): number {
  const id = positional[0];
  if (!id) {
    console.error('status: missing <id>');
    return 2;
  }
  const db = openDb(env.memoryDb);
  try {
    const row = db
      .prepare(`SELECT * FROM crystallizations WHERE id = ?`)
      .get(id);
    if (!row) {
      process.stderr.write(JSON.stringify({ ok: false, reason: 'not_found' }) + '\n');
      return 1;
    }
    const events = db
      .prepare(
        `SELECT event_type, payload, created_at
           FROM crystallization_events
          WHERE crystallization_id = ?
          ORDER BY created_at ASC`,
      )
      .all(id);
    process.stdout.write(JSON.stringify({ row, events }, null, 2) + '\n');
    logInvocation({ cmd: 'status', id });
    return 0;
  } finally {
    db.close();
  }
}

function cmdExpire(env: CliEnv): number {
  const t0 = Date.now();
  preflight(env, false);
  const db = openDb(env.memoryDb);
  try {
    const r = expirePending({ db, skills_root: env.skillsRoot });
    const duration_ms = Date.now() - t0;
    logInvocation({
      cmd: 'expire',
      expired: r.expired_ids.length,
      archived: r.archived_count,
      duration_ms,
    });
    process.stdout.write(JSON.stringify(r) + '\n');
    return 0;
  } finally {
    db.close();
  }
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') help();

  const cmd = argv[0];
  const rest = argv.slice(1);
  const env = resolveEnv();

  await ensureSchema(env.memoryDb);

  // Split positional from flags for sub-commands that take a positional id.
  const flagIdx = rest.findIndex((a) => a.startsWith('-'));
  const positional = flagIdx === -1 ? rest : rest.slice(0, flagIdx);
  const flags = flagIdx === -1 ? [] : rest.slice(flagIdx);

  switch (cmd) {
    case 'scan':
      return await cmdScan(rest, env);
    case 'approve':
      return await cmdApprove(positional, flags, env, 'approve');
    case 'reject':
      return await cmdApprove(positional, flags, env, 'reject');
    case 'list':
      return cmdList(env);
    case 'status':
      return cmdStatus(positional, env);
    case 'expire':
      return cmdExpire(env);
    default:
      console.error(`crystallize: unknown command "${cmd}". Try --help.`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('crystallize: fatal —', err instanceof Error ? err.message : err);
    logInvocation({
      cmd: 'fatal',
      detail: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
