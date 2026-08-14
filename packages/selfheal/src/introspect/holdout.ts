/**
 * Anti-Goodhart held-out evaluation bank (seed-antigoodhart-wiring-2026-06-01, E1).
 *
 * The self-improvement loop grades itself with buildScorecard() and evolve accepts
 * a change when that same scorecard improves — examiner and optimizer are the same
 * instrument (textbook Goodhart). This module is the HIDDEN examiner: a rotating
 * partition of reserved cases that the change-generation path (prescribe / evolve
 * autoloop) never reads. evolve's post-flight compares how the VISIBLE recall metric
 * moved against how the HIDDEN bank moved; a large positive divergence (visible rose,
 * hidden did not) is Goodhart drift and trips a human-escalated flag.
 *
 * Held-out cases live in a FRESH reserved fixture file (holdout-fixtures.json) that is
 * disjoint by construction from the visible continuation eval set — see open_decision
 * D2 in the seed for why a post-hoc split of the existing 10-case set was rejected.
 *
 * tsc note: this file is type-checked (it lives under src/introspect/), so it must stay
 * free of bun:sqlite / Skills imports. The faithful retrieval probe runs in the
 * tsc-excluded standalone runner (standalone/holdout-eval.ts) which this module shells
 * out to. When the runner is unavailable the probe returns null and evolve fail-safes
 * (skips the tripwire) rather than false-flagging.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { getWorkspaceRoot, getDataDir } from 'zouroboros-core';
import { buildHoldoutSandboxEnv } from './holdout-sandbox.js';

const WORKSPACE = getWorkspaceRoot();

/** Divergence above this (visibleDelta - hiddenDelta) trips the Goodhart flag. */
export const DIVERGENCE_TOLERANCE = 0.05;

export interface HoldoutCase {
  id: string;
  query: string;
  expectDetection: boolean;
  expectAny: string[];
}

export interface HoldoutFixtureSet {
  name: string;
  windowDays: number;
  threshold: number;
  facts: unknown[];
  episodes: unknown[];
  openLoops: unknown[];
  cases: HoldoutCase[];
}

export interface HeldoutEvalBank {
  /** Deterministic rotation key (ISO week) selecting the held-out subset for this epoch. */
  epochKey: string;
  /** Case ids reserved out of the visible collectors for this epoch. */
  heldoutCaseIds: string[];
  /** Source fixture file (relative to the package). */
  source: string;
}

export interface DivergenceReport {
  /** Change in the visible metric subset (e.g. Memory Recall) the hidden bank mirrors. */
  visibleDelta: number;
  /** Change in the held-out composite measured on the hidden bank. */
  hiddenDelta: number;
  /** visibleDelta - hiddenDelta; large positive = visible improved while hidden did not. */
  divergence: number;
  /** True when divergence exceeds tolerance; forces evolve success=false + escalation. */
  goodhartFlag: boolean;
}

export interface HiddenCaseResult {
  id: string;
  pass: boolean;
}

export interface EvalIntegrityReport {
  /** Pass fraction over this epoch's held-out partition. */
  heldFrac: number;
  /** Pass fraction over the complement (visible) partition of the same fixture file. */
  visibleFrac: number;
  /** 1 - |heldFrac - visibleFrac|; 1.0 = held and visible partitions agree (healthy). */
  agreement: number;
  heldCount: number;
  visibleCount: number;
}

const FIXTURES_PATH = fileURLToPath(new URL('./holdout-fixtures.json', import.meta.url));

const RUNNER_CANDIDATES = [
  fileURLToPath(new URL('../standalone/holdout-eval.ts', import.meta.url)),
  join(WORKSPACE, 'packages/selfheal/src/standalone/holdout-eval.ts'),
  join(WORKSPACE, 'Skills/zouroboros/skills/selfheal/scripts/holdout-eval.ts'),
];

export function loadHoldoutFixtures(): HoldoutFixtureSet {
  return JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8')) as HoldoutFixtureSet;
}

/** ISO-8601 week key, e.g. "2026-W22". Stable, UTC-based, monotonically rotating. */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to the Thursday of this week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function epochOrdinal(epochKey: string): number {
  const m = epochKey.match(/W(\d+)/);
  if (m) return parseInt(m[1], 10);
  // Non-week key fallback: stable hash so rotation is still deterministic.
  let h = 0;
  for (let i = 0; i < epochKey.length; i++) h = (h * 31 + epochKey.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Rotating partition: select a window of case ids that shifts by one each epoch.
 * Guaranteed to differ across epochs with different ordinals (AC-E1.1) so the loop
 * cannot memorize a fixed held-out set (Larcher 2022 dynamic-holdout discipline).
 */
export function selectHeldout(
  epochKey: string,
  fixtures: HoldoutFixtureSet = loadMergedFixtures()
): HeldoutEvalBank {
  const ids = fixtures.cases.map((c) => c.id).sort();
  const n = ids.length;
  if (n === 0) return { epochKey, heldoutCaseIds: [], source: 'introspect/holdout-fixtures.json' };

  const partitionSize = Math.max(1, Math.ceil(n / 2));
  const offset = ((epochOrdinal(epochKey) % n) + n) % n;
  const heldoutCaseIds: string[] = [];
  for (let i = 0; i < partitionSize; i++) {
    heldoutCaseIds.push(ids[(offset + i) % n]);
  }
  return {
    epochKey,
    heldoutCaseIds: heldoutCaseIds.sort(),
    source: 'introspect/holdout-fixtures.json',
  };
}

/**
 * Composite over per-case results using the SAME weighted-average math as the visible
 * scorecard (scorecard.ts:34): sum(score*weight)/sum(weight). Cases are equally weighted,
 * so this reduces to the pass fraction — but the formula is intentionally identical so the
 * hidden and visible numbers are directly comparable. (AC-E1.2)
 */
export function hiddenComposite(results: HiddenCaseResult[]): number {
  if (results.length === 0) return 0;
  const weight = 1;
  const total = results.reduce((sum, r) => sum + (r.pass ? 1 : 0) * weight, 0);
  const weightSum = results.reduce((sum) => sum + weight, 0);
  return weightSum > 0 ? total / weightSum : 0;
}

export interface ScoreHiddenOptions {
  epochKey?: string;
  /** Injectable probe for tests; defaults to the live standalone runner. */
  probe?: (bank: HeldoutEvalBank) => HiddenCaseResult[] | null;
}

/**
 * Score the hidden composite for the current epoch's held-out partition by running the
 * reserved cases through the REAL continuation retrieval (via the standalone runner).
 * Returns null — never a number — when the bank cannot be measured (runner missing,
 * bun unavailable, parse failure), so callers fail-safe instead of inferring drift from
 * a phantom zero.
 */
export function scoreHiddenComposite(opts: ScoreHiddenOptions = {}): number | null {
  const epochKey = opts.epochKey ?? isoWeekKey();
  const fixtures = loadMergedFixtures();
  const bank = selectHeldout(epochKey, fixtures);
  if (bank.heldoutCaseIds.length === 0) return null;

  const results = opts.probe ? opts.probe(bank) : probeLiveRetrieval(bank);
  if (!results || results.length === 0) return null;
  return hiddenComposite(results);
}

export interface ScoreEvalIntegrityOptions {
  epochKey?: string;
  /** Injectable probe for tests; defaults to the live standalone runner pass map. */
  probe?: () => Map<string, boolean> | null;
}

/**
 * Point-in-time eval-integrity: agreement between this epoch's held-out partition
 * and the complement (visible) partition of holdout-fixtures.json, from a SINGLE
 * runner pass. Both partitions traverse the identical retrieval logic, so a large
 * gap means the eval itself is inconsistent across the rotation — the display-only
 * tripwire measureEvalIntegrity surfaces (weight 0, never an optimizer target).
 * Returns null — never a number — when the bank cannot be measured, so callers
 * fail-safe instead of fabricating drift from a phantom zero.
 */
export function scoreEvalIntegrity(opts: ScoreEvalIntegrityOptions = {}): EvalIntegrityReport | null {
  const epochKey = opts.epochKey ?? isoWeekKey();
  const fixtures = loadMergedFixtures();
  const bank = selectHeldout(epochKey, fixtures);
  if (bank.heldoutCaseIds.length === 0) return null;

  const passed = opts.probe ? opts.probe() : runProbe();
  if (!passed) return null;

  const heldSet = new Set(bank.heldoutCaseIds);
  let heldPass = 0;
  let heldCount = 0;
  let visPass = 0;
  let visCount = 0;
  for (const c of fixtures.cases) {
    if (!passed.has(c.id)) continue;
    const ok = passed.get(c.id) as boolean;
    if (heldSet.has(c.id)) {
      heldCount++;
      if (ok) heldPass++;
    } else {
      visCount++;
      if (ok) visPass++;
    }
  }
  if (heldCount === 0 || visCount === 0) return null;

  const heldFrac = heldPass / heldCount;
  const visibleFrac = visPass / visCount;
  return {
    heldFrac,
    visibleFrac,
    agreement: 1 - Math.abs(heldFrac - visibleFrac),
    heldCount,
    visibleCount: visCount,
  };
}

function findRunner(): string | null {
  for (const p of RUNNER_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Run the standalone retrieval probe once and parse every `HOLDOUT_CASE` line
 * into an id→pass map. Single source of the runner shell-out so the hidden
 * composite and the eval-integrity split share one invocation. Returns null when
 * unmeasurable (runner missing, bun unavailable, no parseable output).
 */
/**
 * Shell out to the standalone runner once and return its raw stdout. Single
 * source of the invocation so the pass map and the display-only sub-rewards
 * share one process. Returns null when unmeasurable (runner missing, bun
 * unavailable, non-zero exit).
 */
function runRunner(): string | null {
  const runner = findRunner();
  if (!runner) return null;
  // Default ON (P0-3): hermetic env strips secrets + refuses egress so the
  // grader child can't be bribed into fudging its own grade. HOLDOUT_SANDBOX=0
  // ⇒ env stays undefined ⇒ execSync inherits process.env (legacy behavior).
  const env =
    process.env.HOLDOUT_SANDBOX === '0' ? undefined : buildHoldoutSandboxEnv(process.env);
  try {
    return execSync(`bun "${runner}" 2>/dev/null`, {
      cwd: WORKSPACE,
      timeout: 60000,
      encoding: 'utf-8',
      env,
    });
  } catch {
    return null;
  }
}

function runProbe(): Map<string, boolean> | null {
  const out = runRunner();
  if (out === null) return null;
  const passed = new Map<string, boolean>();
  for (const line of out.split('\n')) {
    const m = line.match(/^HOLDOUT_CASE\s+(\S+)\s+([01])\s*$/);
    if (m) passed.set(m[1], m[2] === '1');
  }
  return passed.size > 0 ? passed : null;
}

export type SubcheckKind = 'detection' | 'content';

export interface HoldoutSubcheck {
  id: string;
  kind: SubcheckKind;
  pass: boolean;
}

/**
 * Pure parser for the display-only `HOLDOUT_SUBCHECK` lines (P0-3). These are
 * weight-0 diagnostics — NEVER an optimizer target. Only HOLDOUT_CASE feeds the
 * reward; this surfaces WHICH half (detection vs content) of a failing case
 * broke, for human-readable post-flight display.
 */
export function parseHoldoutSubchecks(out: string): HoldoutSubcheck[] {
  const subs: HoldoutSubcheck[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^HOLDOUT_SUBCHECK\s+(\S+)\s+(detection|content)\s+([01])\s*$/);
    if (m) subs.push({ id: m[1], kind: m[2] as SubcheckKind, pass: m[3] === '1' });
  }
  return subs;
}

/**
 * Run the live probe and return its sub-rewards for display. Returns null when
 * unmeasurable or when HOLDOUT_SUBCHECKS=0 (runner emits no subcheck lines).
 * Display-only: no caller may route this into a scorecard or evolve gate.
 */
export function probeSubchecks(): HoldoutSubcheck[] | null {
  const out = runRunner();
  if (out === null) return null;
  const subs = parseHoldoutSubchecks(out);
  return subs.length > 0 ? subs : null;
}

function probeLiveRetrieval(bank: HeldoutEvalBank): HiddenCaseResult[] | null {
  const passed = runProbe();
  if (!passed) return null;
  const selected = bank.heldoutCaseIds.filter((id) => passed.has(id));
  if (selected.length === 0) return null;
  return selected.map((id) => ({ id, pass: passed.get(id) as boolean }));
}

export function buildDivergenceReport(
  visibleDelta: number,
  hiddenDelta: number,
  tolerance: number = DIVERGENCE_TOLERANCE
): DivergenceReport {
  const divergence = visibleDelta - hiddenDelta;
  return {
    visibleDelta,
    hiddenDelta,
    divergence,
    goodhartFlag: divergence > tolerance,
  };
}

/* ------------------------------------------------------------------ *
 * ZOU-279 — held-out bank replenishment (dynamic-holdout discipline)
 *
 * The committed bank (holdout-fixtures.json) is a fixed synthetic seed. A fixed
 * examiner is eventually memorizable by the optimizer even though it never reads
 * the file (Larcher 2022). Replenishment mints FRESH cases from RECENT REAL
 * continuations so the examiner keeps moving. Two invariants make this safe:
 *
 *   1. Provable disjointness from the VISIBLE continuation eval set — a minted
 *      case may not share any domain token with the visible bank, so a change that
 *      lifts visible recall cannot mechanically lift the hidden bank (which would
 *      mask Goodhart). Enforced at mint time AND re-checkable via verifyDisjoint.
 *   2. Real continuation content never enters git. Minted cases live ONLY in a
 *      local bank under the data dir (~/.zouroboros), never the committed seed —
 *      respecting the confidentiality posture for live memory content.
 * ------------------------------------------------------------------ */

/** Max minted cases retained in the rotating local bank (oldest evicted). */
export const REPLENISH_MAX_CASES = 12;
/** Days since the newest mint above which the bank is considered stale. */
export const FRESHNESS_STALE_DAYS = 14;
/** Days since the newest mint at which freshness scores zero. */
export const FRESHNESS_CRITICAL_DAYS = 28;

const LOCAL_BANK_FILENAME = 'holdout-fixtures.local.json';

const VISIBLE_FIXTURE_CANDIDATES = [
  join(WORKSPACE, 'Skills/zo-memory-system/assets/continuation-eval-fixture-set.json'),
];

/** A real open loop mined from the live memory DB, ready for synthesis. */
export interface ReplenishCandidate {
  title: string;
  summary: string;
  kind: string;
  status: string;
  priority: number;
  entity: string | null;
  createdDaysAgo: number;
  updatedDaysAgo: number;
}

export interface ReplenishedCase extends HoldoutCase {
  /** Epoch seconds when the case was minted (drives freshness + eviction). */
  mintedAt: number;
  /** Provenance tag, e.g. 'replenish:open-loop'. */
  source: string;
}

/** A minted case bundled with the open-loop record the eval seeds to satisfy it. */
export interface ReplenishedEntry extends ReplenishedCase {
  seedLoop: {
    title: string;
    summary: string;
    kind: string;
    status: string;
    priority: number;
    entity: string;
    createdDaysAgo: number;
    updatedDaysAgo: number;
  };
}

export interface ReplenishedBank {
  name: string;
  windowDays: number;
  threshold: number;
  /** Last write time (epoch seconds). */
  mintedAt: number;
  entries: ReplenishedEntry[];
}

export interface ReplenishReport {
  added: number;
  rejectedDisjoint: number;
  total: number;
  disjoint: boolean;
}

export interface BankFreshness {
  replenishedCount: number;
  seedCaseCount: number;
  /** Newest mint time across the local bank, or null when seed-only. */
  lastMintedAt: number | null;
  /** Days since the newest mint, or null when seed-only. */
  ageDays: number | null;
  stale: boolean;
}

/** Tokens that identify a DOMAIN; generic continuation phrasing is intentionally ignored. */
const VOCAB_STOPWORDS = new Set([
  'project', 'decision', 'incident', 'service', 'task', 'work', 'next', 'step',
  'still', 'open', 'pending', 'review', 'status', 'update', 'fix', 'before',
  'after', 'with', 'from', 'into', 'that', 'this', 'them', 'their', 'should',
  'must', 'need', 'needs', 'confirm', 'check', 'about',
]);

function vocabTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !VOCAB_STOPWORDS.has(t));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

export function loadVisibleFixtures(): HoldoutFixtureSet | null {
  for (const p of VISIBLE_FIXTURE_CANDIDATES) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8')) as HoldoutFixtureSet;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Domain vocabulary of the VISIBLE set: entity tokens + expectAny needle tokens.
 * Generic continuation phrasing (queries) is deliberately excluded so disjointness
 * gates on identifying domain terms, not on shared question shape.
 */
export function buildVisibleVocabulary(visible: HoldoutFixtureSet): Set<string> {
  const vocab = new Set<string>();
  const add = (s?: string | null) => {
    for (const t of vocabTokens(s)) vocab.add(t);
  };
  for (const f of visible.facts as Array<Record<string, unknown>>) add(f.entity as string);
  for (const e of visible.episodes as Array<Record<string, unknown>>) {
    for (const en of (e.entities as string[]) ?? []) add(en);
  }
  for (const l of visible.openLoops as Array<Record<string, unknown>>) add(l.entity as string);
  for (const c of visible.cases) {
    for (const n of c.expectAny) add(n);
  }
  return vocab;
}

export function localReplenishBankPath(): string {
  return join(getDataDir(), LOCAL_BANK_FILENAME);
}

export function loadLocalReplenishedBank(): ReplenishedBank | null {
  const p = localReplenishBankPath();
  if (!existsSync(p)) return null;
  try {
    const bank = JSON.parse(readFileSync(p, 'utf-8')) as ReplenishedBank;
    return Array.isArray(bank.entries) ? bank : null;
  } catch {
    return null;
  }
}

export function writeLocalReplenishedBank(bank: ReplenishedBank): void {
  const p = localReplenishBankPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(bank, null, 2));
}

/**
 * Merged view consumed by selection + the eval runner: the committed synthetic seed
 * plus the local minted cases. CI / fresh checkouts have no local bank, so the merged
 * view degrades to the seed and every existing invariant holds unchanged.
 */
export function loadMergedFixtures(): HoldoutFixtureSet {
  const seed = loadHoldoutFixtures();
  const local = loadLocalReplenishedBank();
  if (!local || local.entries.length === 0) return seed;
  return {
    ...seed,
    openLoops: [...(seed.openLoops as unknown[]), ...local.entries.map((e) => e.seedLoop)],
    cases: [
      ...seed.cases,
      ...local.entries.map((e) => ({
        id: e.id,
        query: e.query,
        expectDetection: e.expectDetection,
        expectAny: e.expectAny,
      })),
    ],
  };
}

/**
 * Synthesize minted cases (+ aligned seed loops) from mined candidates, dropping any
 * whose domain tokens collide with the visible vocabulary. Pure: no fs / DB access.
 * Returned `cases[i]` and `openLoops[i]` are index-aligned.
 */
export function synthesizeHoldoutCases(
  candidates: ReplenishCandidate[],
  visibleVocab: Set<string>,
  now: number = Math.floor(Date.now() / 1000)
): { cases: ReplenishedCase[]; openLoops: ReplenishedEntry['seedLoop'][]; rejected: number } {
  const cases: ReplenishedCase[] = [];
  const openLoops: ReplenishedEntry['seedLoop'][] = [];
  const seenIds = new Set<string>();
  let rejected = 0;

  for (const c of candidates) {
    const entity = (c.entity ?? '').trim();
    const entityShort = entity.includes('.') ? entity.split('.').slice(-1)[0] : entity;
    const titleTokens = vocabTokens(c.title);
    const entityTokens = vocabTokens(entityShort);
    const domainTokens = new Set([...entityTokens, ...titleTokens]);

    if (domainTokens.size === 0) {
      rejected++;
      continue;
    }
    let collides = false;
    for (const t of domainTokens) {
      if (visibleVocab.has(t)) {
        collides = true;
        break;
      }
    }
    if (collides) {
      rejected++;
      continue;
    }

    const contentTokens = Array.from(new Set([...entityTokens, ...titleTokens, ...vocabTokens(c.summary)]))
      .filter((t) => !visibleVocab.has(t));
    const needles = contentTokens.slice(0, 3);
    if (needles.length === 0) {
      rejected++;
      continue;
    }

    const label = (entityShort || needles[0]).replace(/[-_]/g, ' ').trim();
    const id = `holdout-r-${slugify(label) || 'case'}-${shortHash(c.title + entity)}`;
    if (seenIds.has(id)) {
      rejected++;
      continue;
    }
    seenIds.add(id);

    cases.push({
      id,
      query: `where did we leave off on ${label}?`,
      expectDetection: true,
      expectAny: needles,
      mintedAt: now,
      source: 'replenish:open-loop',
    });
    openLoops.push({
      title: c.title,
      summary: c.summary,
      kind: c.kind,
      status: c.status,
      priority: c.priority,
      entity,
      createdDaysAgo: c.createdDaysAgo,
      updatedDaysAgo: c.updatedDaysAgo,
    });
  }

  return { cases, openLoops, rejected };
}

/**
 * Re-checkable disjointness guarantee: minted cases must not collide with the visible
 * set on case id OR on any expectAny domain token. verifyDisjoint(bank, visible) is the
 * provable check the metric and tests run against the live local bank.
 */
export function verifyDisjoint(
  bank: { cases: Array<{ id: string; expectAny: string[] }> },
  visible: HoldoutFixtureSet
): { disjoint: boolean; idCollisions: string[]; vocabCollisions: string[] } {
  const visibleIds = new Set(visible.cases.map((c) => c.id));
  const vocab = buildVisibleVocabulary(visible);
  const idCollisions = bank.cases.filter((c) => visibleIds.has(c.id)).map((c) => c.id);
  const vocabCollisions: string[] = [];
  for (const c of bank.cases) {
    for (const n of c.expectAny) {
      for (const t of vocabTokens(n)) {
        if (vocab.has(t)) vocabCollisions.push(`${c.id}:${t}`);
      }
    }
  }
  return {
    disjoint: idCollisions.length === 0 && vocabCollisions.length === 0,
    idCollisions,
    vocabCollisions,
  };
}

/** Combine existing + new entries (new wins on id), keep the newest `max` by mintedAt. */
export function mergeReplenished(
  existing: ReplenishedBank | null,
  add: ReplenishedEntry[],
  max: number = REPLENISH_MAX_CASES,
  now: number = Math.floor(Date.now() / 1000)
): ReplenishedBank {
  const byId = new Map<string, ReplenishedEntry>();
  for (const e of existing?.entries ?? []) byId.set(e.id, e);
  for (const e of add) byId.set(e.id, e);
  const entries = Array.from(byId.values())
    .sort((a, b) => b.mintedAt - a.mintedAt)
    .slice(0, max);
  return {
    name: existing?.name ?? 'holdout-replenished-local',
    windowDays: existing?.windowDays ?? 14,
    threshold: existing?.threshold ?? 0.85,
    mintedAt: now,
    entries,
  };
}

/**
 * Orchestrate one replenishment pass from already-mined candidates: synthesize →
 * enforce disjointness → merge into the rotating local bank → persist. The live DB
 * read happens in the tsc-excluded standalone runner, which passes candidates here.
 */
export function replenishHoldoutBank(opts: {
  candidates: ReplenishCandidate[];
  now?: number;
  max?: number;
}): ReplenishReport {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const visible = loadVisibleFixtures();
  const vocab = visible ? buildVisibleVocabulary(visible) : new Set<string>();
  const { cases, openLoops, rejected } = synthesizeHoldoutCases(opts.candidates, vocab, now);
  const entries: ReplenishedEntry[] = cases.map((c, i) => ({ ...c, seedLoop: openLoops[i] }));
  const merged = mergeReplenished(loadLocalReplenishedBank(), entries, opts.max ?? REPLENISH_MAX_CASES, now);
  writeLocalReplenishedBank(merged);
  const check = visible ? verifyDisjoint({ cases: merged.entries }, visible) : { disjoint: true };
  return { added: cases.length, rejectedDisjoint: rejected, total: merged.entries.length, disjoint: check.disjoint };
}

/** Staleness of the held-out bank — surfaced as a weight-0 tripwire (collector.ts). */
export function bankFreshness(now: number = Date.now()): BankFreshness {
  const seed = loadHoldoutFixtures();
  const local = loadLocalReplenishedBank();
  const count = local?.entries.length ?? 0;
  const lastMintedAt = count > 0 ? Math.max(...local!.entries.map((e) => e.mintedAt)) : null;
  const ageDays = lastMintedAt !== null ? (now / 1000 - lastMintedAt) / 86400 : null;
  return {
    replenishedCount: count,
    seedCaseCount: seed.cases.length,
    lastMintedAt,
    ageDays,
    stale: ageDays !== null && ageDays > FRESHNESS_STALE_DAYS,
  };
}
