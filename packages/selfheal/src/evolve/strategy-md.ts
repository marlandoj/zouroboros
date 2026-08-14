/**
 * Append-only compounding strategy scratchpad for the evolve loop (roadmap #11,
 * AIEWF §11 / Browserbase "compounding memory").
 *
 * The intervention ledger (ZOU-280) records the *numeric* state-delta of each run as
 * machine-structured JSON. What it does NOT capture is the loop's free-form working
 * memory: "last time I tried the cheap probe here and it fell 0.04 short, so the autoloop
 * budget was justified." Without that, every evolve run on a given playbook starts cold —
 * it rediscovers, iteration after iteration, what a prior run already learned. That is the
 * Browserbase "no compounding memory" anti-pattern.
 *
 * This module is the deterministic, per-playbook scratchpad that closes that hole. It is a
 * plain markdown file `z-strategy-<playbookId>.md` beside the program file at the workspace
 * root. Entries are APPEND-ONLY (never rewritten) so history is immutable and races are
 * impossible. The render/parse/format functions are PURE (no fs, no clock) so they are
 * offline-testable; only the thin `appendStrategyNote`/`loadStrategy` wrappers touch disk,
 * and both fail safe (a corrupt/absent file yields an empty history, never a crash).
 *
 * No LLM, no network. Advisory by default at the call site: the formatted context is fed
 * back into the evolve step as prior-art, but it never blocks or alters control flow.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';

export const STRATEGY_FILE_PREFIX = 'z-strategy-';

/** One append-only record of what the evolve loop tried for a playbook and how it went. */
export interface StrategyEntry {
  /** ISO timestamp the entry was written. */
  timestamp: string;
  /** Prescription that produced this attempt. */
  prescriptionId: string;
  /** Monotonic attempt counter for this playbook (0-based). */
  iteration: number;
  /** Classified regime at the time of the attempt ('deterministic' | 'agentic' | 'unknown' | …). */
  regime: string;
  /** Short description of what was attempted (e.g. 'cheap-probe short-circuit', 'autoloop'). */
  action: string;
  /** Short description of how it turned out (e.g. 'met target 0.9', 'fell 0.04 short'). */
  outcome: string;
  /** Optional free-form memo carried forward to later iterations. */
  note?: string;
}

/** Header line pattern: `## <timestamp> · iter <n> · <regime>`. */
const HEADER_RE = /^##\s+(.+?)\s+·\s+iter\s+(\d+)\s+·\s+(\S+)\s*$/;
/** Bullet field pattern: `- <key>: <value>`. */
const FIELD_RE = /^-\s+(\w+):\s?(.*)$/;

/** Collapse newlines so each entry stays a fixed, round-trippable block. */
function oneLine(s: string): string {
  return s.replace(/\r?\n/g, ' ').trim();
}

/**
 * Render one entry as a markdown block. PURE. Symmetric with `parseStrategyMarkdown`.
 * Ends with a trailing newline so appended entries never run together.
 */
export function renderStrategyEntry(e: StrategyEntry): string {
  const lines = [
    `## ${e.timestamp} · iter ${e.iteration} · ${e.regime}`,
    `- prescription: ${oneLine(e.prescriptionId)}`,
    `- action: ${oneLine(e.action)}`,
    `- outcome: ${oneLine(e.outcome)}`,
  ];
  const note = e.note ? oneLine(e.note) : '';
  if (note) lines.push(`- note: ${note}`);
  return lines.join('\n') + '\n';
}

/**
 * Parse a strategy markdown file back into entries. PURE. Tolerant: unknown lines and the
 * file preamble are ignored; malformed entries contribute whatever fields they could match.
 */
export function parseStrategyMarkdown(content: string): StrategyEntry[] {
  const entries: StrategyEntry[] = [];
  let cur: StrategyEntry | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    const h = HEADER_RE.exec(line);
    if (h) {
      if (cur) entries.push(cur);
      cur = {
        timestamp: h[1],
        iteration: parseInt(h[2], 10),
        regime: h[3],
        prescriptionId: '',
        action: '',
        outcome: '',
      };
      continue;
    }
    if (!cur) continue;
    const m = FIELD_RE.exec(line);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'prescription') cur.prescriptionId = val;
    else if (key === 'action') cur.action = val;
    else if (key === 'outcome') cur.outcome = val;
    else if (key === 'note') cur.note = val;
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * Render the most recent N entries as a seed-ready context block so the evolve step sees
 * the loop's prior attempts on this playbook. PURE. Empty history ⇒ empty string (the
 * caller then injects nothing, staying byte-identical to today).
 */
export function formatStrategyContext(entries: StrategyEntry[], opts: { limit?: number } = {}): string {
  if (entries.length === 0) return '';
  const limit = opts.limit ?? 5;
  const recent = entries.slice(-limit);
  const lines: string[] = ['prior_strategy_notes:'];
  for (const e of recent) {
    const noteSuffix = e.note ? ` (${e.note})` : '';
    lines.push(`  - "iter ${e.iteration} [${e.regime}] ${e.action} → ${e.outcome}${noteSuffix}"`);
  }
  return lines.join('\n');
}

function getWorkspace(): string {
  return getWorkspaceRoot();
}

/** Filename-safe playbook id (keeps the strategy file next to the program file). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Absolute path of the strategy file for a playbook. */
export function strategyPath(playbookId: string, dir?: string): string {
  return join(dir ?? getWorkspace(), `${STRATEGY_FILE_PREFIX}${sanitizeId(playbookId)}.md`);
}

function strategyHeader(playbookId: string): string {
  return [
    `# Strategy scratchpad — playbook \`${playbookId}\``,
    '',
    'Append-only compounding memo written by the evolve loop. Each entry records what the',
    'loop tried for this playbook and how it turned out, so later iterations build on prior',
    'attempts instead of rediscovering them. Newest entries are appended at the bottom.',
    '',
  ].join('\n');
}

export interface AppendStrategyInput {
  playbookId: string;
  prescriptionId: string;
  iteration: number;
  regime: string;
  action: string;
  outcome: string;
  note?: string;
}

export interface StrategyOptions {
  dir?: string;
  now?: number;
}

/**
 * Append one entry to the playbook's strategy file. Creates the file (with a human-readable
 * preamble) on first write. APPEND-ONLY — existing entries are never rewritten. Returns the
 * stored entry.
 */
export function appendStrategyNote(input: AppendStrategyInput, opts: StrategyOptions = {}): StrategyEntry {
  const now = opts.now ?? Date.now();
  const entry: StrategyEntry = {
    timestamp: new Date(now).toISOString(),
    prescriptionId: input.prescriptionId,
    iteration: input.iteration,
    regime: input.regime,
    action: input.action,
    outcome: input.outcome,
    note: input.note,
  };
  const path = strategyPath(input.playbookId, opts.dir);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, strategyHeader(input.playbookId));
  }
  appendFileSync(path, '\n' + renderStrategyEntry(entry));
  return entry;
}

/**
 * Load the append-only history for a playbook. Fail-safe: absent or unreadable file ⇒ []
 * (the loop proceeds exactly as today, with no prior-art context).
 */
export function loadStrategy(playbookId: string, dir?: string): StrategyEntry[] {
  const path = strategyPath(playbookId, dir);
  if (!existsSync(path)) return [];
  try {
    return parseStrategyMarkdown(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Next iteration index for a playbook = count of existing entries. Convenience for callers
 * that want a monotonic attempt counter without loading + measuring history themselves.
 */
export function nextIteration(playbookId: string, dir?: string): number {
  return loadStrategy(playbookId, dir).length;
}
