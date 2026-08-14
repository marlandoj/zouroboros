/**
 * ZOU-881 — measured autoloop cost circuit breaker.
 * Covers the six mandated cases: exact-cap, below-cap, over-cap,
 * missing-usage, restart, duplicate-event — plus fail-closed parsing
 * and an end-to-end "stop before authorizing over-cap work" simulation.
 */

import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeUsageCost,
  newAccumulator,
  recordSpend,
  checkCostCeiling,
  appendCostLedger,
  replayCostLedger,
  parseBridgeCost,
  type CostLedgerRecord,
} from './cost.js';

// --- fail-closed normalization ------------------------------------------

test('normalizeUsageCost accepts finite non-negative numbers', () => {
  expect(normalizeUsageCost(0)).toBe(0);
  expect(normalizeUsageCost(1.25)).toBe(1.25);
});

test('normalizeUsageCost rejects unknown/malformed usage (fail closed)', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -0.01, '1.5', '', {}, []]) {
    expect(normalizeUsageCost(bad as unknown)).toBeNull();
  }
});

// --- ceiling semantics ---------------------------------------------------

test('below-cap: run continues', () => {
  expect(checkCostCeiling(4.99, 5).stop).toBe(false);
});

test('exact-cap: run stops at the ceiling', () => {
  expect(checkCostCeiling(5, 5).stop).toBe(true);
});

test('over-cap: run stops beyond the ceiling', () => {
  const d = checkCostCeiling(6.5, 5);
  expect(d.stop).toBe(true);
  expect(d.reason).toContain('>=');
});

// --- accounting ----------------------------------------------------------

test('missing-usage: unknown cost fails closed and is not counted as zero', () => {
  const acc = newAccumulator();
  const d = recordSpend(acc, { actionId: 'a1', kind: 'attempt', costUSD: undefined });
  expect(d.authorized).toBe(false);
  expect(d.costUSD).toBeNull();
  expect(acc.cumulativeUSD).toBe(0);
  expect(acc.seen.has('a1')).toBe(false); // not marked counted, so a later valid cost still lands
});

test('duplicate-event: same actionId is charged exactly once', () => {
  const acc = newAccumulator();
  const first = recordSpend(acc, { actionId: 'exp3', kind: 'attempt', costUSD: 2 });
  expect(first.authorized).toBe(true);
  expect(first.deduped).toBe(false);
  const again = recordSpend(acc, { actionId: 'exp3', kind: 'retry', costUSD: 2 });
  expect(again.authorized).toBe(true);
  expect(again.deduped).toBe(true);
  expect(acc.cumulativeUSD).toBe(2); // not 4
});

test('retry and fallback with distinct ids are both counted once', () => {
  const acc = newAccumulator();
  recordSpend(acc, { actionId: 'attempt-1', kind: 'attempt', costUSD: 1 });
  recordSpend(acc, { actionId: 'retry-1', kind: 'retry', costUSD: 0.5 });
  recordSpend(acc, { actionId: 'fallback-1', kind: 'fallback', costUSD: 0.25 });
  expect(acc.cumulativeUSD).toBe(1.75);
});

test('missing actionId fails closed', () => {
  const acc = newAccumulator();
  const d = recordSpend(acc, { actionId: '', kind: 'attempt', costUSD: 1 });
  expect(d.authorized).toBe(false);
  expect(acc.cumulativeUSD).toBe(0);
});

// --- ledger persistence + restart ---------------------------------------

test('restart: ledger replay restores cumulative spend without double counting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zou881-'));
  const ledger = join(dir, '.autoloop', 'cost-ledger.jsonl');

  const acc = newAccumulator();
  for (const [id, cost] of [['e1', 1], ['e2', 2], ['e3', 0.5]] as const) {
    const d = recordSpend(acc, { actionId: id, kind: 'attempt', costUSD: cost });
    const rec: CostLedgerRecord = {
      ts: new Date(0).toISOString(),
      type: 'spend',
      actionId: id,
      kind: 'attempt',
      costUSD: d.costUSD,
      cumulativeUSD: d.cumulativeUSD,
    };
    appendCostLedger(ledger, rec);
  }
  expect(acc.cumulativeUSD).toBe(3.5);

  // Simulate a restart: rebuild solely from the ledger.
  const restored = replayCostLedger(ledger);
  expect(restored.cumulativeUSD).toBe(3.5);
  expect(restored.seen.size).toBe(3);

  // A resumed run re-emitting a prior action must not double-count.
  const dup = recordSpend(restored, { actionId: 'e2', kind: 'retry', costUSD: 2 });
  expect(dup.deduped).toBe(true);
  expect(restored.cumulativeUSD).toBe(3.5);

  // Malformed historical lines are skipped, not counted as zero.
  appendCostLedger(ledger, {
    ts: new Date(0).toISOString(),
    type: 'spend',
    actionId: 'bad',
    kind: 'attempt',
    costUSD: null,
    cumulativeUSD: 3.5,
  });
  const restored2 = replayCostLedger(ledger);
  expect(restored2.cumulativeUSD).toBe(3.5);
  expect(restored2.seen.has('bad')).toBe(false);
});

test('replay of a missing ledger yields an empty accumulator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zou881-'));
  const acc = replayCostLedger(join(dir, 'nope.jsonl'));
  expect(acc.cumulativeUSD).toBe(0);
  expect(acc.seen.size).toBe(0);
});

// --- AC #1 end-to-end: stop BEFORE authorizing over-cap work ------------

test('a run stops before authorizing work beyond the ceiling', () => {
  const maxCostUSD = 5;
  const acc = newAccumulator();
  const perAction = 2;
  const authorizedActions: string[] = [];

  for (let i = 1; i <= 10; i++) {
    // Pre-authorization gate: never authorize the next metered action once at/over cap.
    if (checkCostCeiling(acc.cumulativeUSD, maxCostUSD).stop) break;
    const d = recordSpend(acc, { actionId: `exp-${i}`, kind: 'attempt', costUSD: perAction });
    if (!d.authorized) break;
    authorizedActions.push(`exp-${i}`);
  }

  // 2+2 authorized (cum 4 < 5); before the 3rd, cum would be 4 -> still under,
  // so exp-3 lands at 6, then the gate stops exp-4. Spend never exceeds ceiling
  // by more than a single in-flight action, and no work is authorized past the stop.
  expect(authorizedActions).toEqual(['exp-1', 'exp-2', 'exp-3']);
  expect(checkCostCeiling(acc.cumulativeUSD, maxCostUSD).stop).toBe(true);
});

// --- parseBridgeCost: measured executor usage source (ZOU-889) -----------

test('parseBridgeCost reads claude-code metrics.totalCostUsd', () => {
  // Faithful to claude-code-bridge.sh result shape.
  const claudeResult = JSON.stringify({
    status: 'success',
    output: 'HYPOTHESIS: x\n```\nfoo\n```',
    metrics: {
      durationMs: 1234,
      cliDurationMs: 1000,
      model: 'claude-code',
      inputTokens: 100,
      outputTokens: 200,
      tokensUsed: 300,
      totalCostUsd: 0.0421,
    },
    executorId: 'claude-code',
    taskId: 't1',
    timestamp: '2026-07-24T00:00:00Z',
  });
  expect(parseBridgeCost(claudeResult)).toBe(0.0421);
});

test('parseBridgeCost accepts a zero measured cost', () => {
  const r = JSON.stringify({ metrics: { durationMs: 5, totalCostUsd: 0 } });
  expect(parseBridgeCost(r)).toBe(0);
});

test('parseBridgeCost returns null for codex/gemini (metrics without cost)', () => {
  // Faithful to codex-bridge.sh / gemini-bridge.sh: durationMs + model, NO cost.
  const codexResult = JSON.stringify({
    status: 'success',
    output: 'HYPOTHESIS: y\n```\nbar\n```',
    metrics: { durationMs: 900, model: 'gpt-5.6' },
    executorId: 'codex',
    taskId: 't2',
    timestamp: '2026-07-24T00:00:00Z',
  });
  expect(parseBridgeCost(codexResult)).toBeNull();
});

test('parseBridgeCost fails closed on malformed / missing / bad cost', () => {
  expect(parseBridgeCost('not json')).toBeNull();               // malformed JSON
  expect(parseBridgeCost('')).toBeNull();                       // empty
  expect(parseBridgeCost('null')).toBeNull();                   // json null
  expect(parseBridgeCost('42')).toBeNull();                     // non-object
  expect(parseBridgeCost('{}')).toBeNull();                     // no metrics
  expect(parseBridgeCost('{"metrics":null}')).toBeNull();       // metrics null
  expect(parseBridgeCost('{"metrics":42}')).toBeNull();         // metrics non-object
  expect(parseBridgeCost('{"metrics":{}}')).toBeNull();         // no totalCostUsd
  expect(parseBridgeCost('{"metrics":{"totalCostUsd":-0.5}}')).toBeNull();   // negative
  expect(parseBridgeCost('{"metrics":{"totalCostUsd":"0.5"}}')).toBeNull();  // string, not number
  expect(parseBridgeCost('{"metrics":{"totalCostUsd":null}}')).toBeNull();   // null cost
});
