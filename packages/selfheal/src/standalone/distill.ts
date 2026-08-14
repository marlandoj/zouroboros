#!/usr/bin/env bun
/**
 * Standalone runner for periodic distillation (ZOU-282, #5).
 *
 * The reachable orchestrator that wires the CI-tested distillation gate
 * (distill/distillation-gate.ts) to live state:
 *   1. counts the memory + procedure corpus (facts / episodes / procedures) and fingerprints it,
 *   2. runs the REAL anti-Goodhart drift audit — held-out eval integrity (introspect/holdout.ts)
 *      + recent Goodhart-flagged interventions (evolve/intervention-ledger.ts),
 *   3. gates: refuses (exit 3) if the audit is not clean or the corpus is too thin; otherwise
 *      writes a DistillationManifest to the data dir for the out-of-process trainer.
 *
 * Fail-closed by construction: an unmeasurable held-out bank makes the audit not-clean, so a
 * environment where cleanliness cannot be proven refuses rather than distilling blind.
 *
 * Lives under standalone/ (tsc-excluded) — it shells out to sqlite3 and imports the live
 * held-out probe — but is scanned by the Wiring Sentinel, so importing the gate functions
 * here is what marks them reachable.
 *
 * Modes:
 *   (default)       audit + gate; write manifest on PROCEED, print refusal + exit 3 on REFUSE.
 *   --audit-only    run the drift audit and print the result; never writes a manifest.
 *   --accept <pre> <post>   post-training acceptance gate: accept iff held-out score didn't regress.
 * Options:
 *   --base-model <id>   base model for the manifest (default from DISTILL_BASE_MODEL).
 *   --json              machine-readable output only.
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from 'zouroboros-core';
import {
  auditCorpusDrift,
  gateDistillation,
  evaluateDistillationArtifact,
  buildCorpusSnapshot,
  summarizeDecision,
  type RecentDriftFlag,
} from '../distill/distillation-gate.js';
import { scoreEvalIntegrity } from '../introspect/holdout.js';
import { interventionsWithDrift } from '../evolve/intervention-ledger.js';

const DATA_DIR = getDataDir();
const MANIFEST_PATH = join(DATA_DIR, 'distillation-manifest.json');

/** Candidate stores for the corpus counts. First existing wins per store. */
const FACTS_DB_CANDIDATES = [
  process.env.ZOUROBOROS_MEMORY_DB,
  join(DATA_DIR, 'memory.db'),
].filter(Boolean) as string[];
const PROCEDURES_DB_CANDIDATES = [
  process.env.ZOUROBOROS_SHARED_FACTS_DB,
  join(DATA_DIR, 'shared-facts.db'),
].filter(Boolean) as string[];

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

/** COUNT(*) on a table, or 0 when the store/table is absent/unreadable (fail-safe). */
function countRows(db: string | null, table: string): number {
  if (!db) return 0;
  try {
    const out = execSync(`sqlite3 "${db}" "SELECT COUNT(*) FROM ${table};" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const n = parseInt(out.split('\n')[0] ?? '', 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** A small set of row-id keys per store for the order-independent corpus fingerprint. */
function rowKeys(db: string | null, table: string, idCol: string, tag: string): string[] {
  if (!db) return [];
  try {
    const out = execSync(
      `sqlite3 "${db}" "SELECT ${idCol} FROM ${table} ORDER BY ${idCol} LIMIT 5000;" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((id) => `${tag}:${id}`);
  } catch {
    return [];
  }
}

function snapshotCorpus() {
  const memDb = firstExisting(FACTS_DB_CANDIDATES);
  const sharedDb = firstExisting(PROCEDURES_DB_CANDIDATES);
  const facts = countRows(memDb, 'facts');
  const episodes = countRows(memDb, 'episodes');
  const procedures = countRows(sharedDb, 'procedures');
  const itemKeys = [
    ...rowKeys(memDb, 'facts', 'id', 'f'),
    ...rowKeys(memDb, 'episodes', 'id', 'e'),
    ...rowKeys(sharedDb, 'procedures', 'id', 'p'),
  ];
  return buildCorpusSnapshot({ facts, episodes, procedures, itemKeys });
}

function collectDriftFlags(): RecentDriftFlag[] {
  return interventionsWithDrift().map((r) => ({
    prescriptionId: r.prescriptionId,
    playbookId: r.playbookId,
    createdAt: r.createdAt,
    drift: r.drift!,
  }));
}

function runAudit() {
  const evalIntegrity = scoreEvalIntegrity();
  const driftFlags = collectDriftFlags();
  return auditCorpusDrift({ evalIntegrity, driftFlags });
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');

  // Acceptance-gate mode: --accept <preHidden> <postHidden>
  const acceptIdx = argv.indexOf('--accept');
  if (acceptIdx !== -1) {
    const pre = Number(argv[acceptIdx + 1]);
    const postArg = argv[acceptIdx + 2];
    const post = postArg === 'null' || postArg === undefined ? null : Number(postArg);
    const verdict = evaluateDistillationArtifact(pre, post);
    if (json) console.log(JSON.stringify(verdict, null, 2));
    else console.log(`${verdict.accept ? 'ACCEPT' : 'REJECT'} — ${verdict.reason}`);
    process.exit(verdict.accept ? 0 : 4);
  }

  const audit = runAudit();

  if (argv.includes('--audit-only')) {
    if (json) console.log(JSON.stringify(audit, null, 2));
    else
      console.log(
        `${audit.clean ? 'CLEAN' : 'NOT CLEAN'} — agreement=${audit.evalAgreement ?? 'n/a'} ` +
          `recentDrift=${audit.recentDriftCount}${audit.clean ? '' : '\n  ' + audit.reasons.join('\n  ')}`
      );
    process.exit(audit.clean ? 0 : 3);
  }

  const snapshot = snapshotCorpus();
  const decision = gateDistillation(snapshot, audit, {
    baseModel: process.env.DISTILL_BASE_MODEL,
  });

  if (!decision.proceed) {
    if (json) console.log(JSON.stringify(decision, null, 2));
    else console.error(summarizeDecision(decision));
    process.exit(3);
  }

  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(decision.manifest, null, 2));
  if (json) console.log(JSON.stringify(decision, null, 2));
  else console.log(`${summarizeDecision(decision)}\n  manifest → ${MANIFEST_PATH}`);
  process.exit(0);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`distill: ${(err as Error).message}`);
    process.exit(1);
  }
}
