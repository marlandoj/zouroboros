/**
 * llm-draft / makeRealLlmDriver — FX-21.
 *
 * Asserts:
 *   • happy path reserves, calls injected generator, records actual spend
 *   • cap exceeded ⇒ throws LlmCostCapExceededError BEFORE invoking generator
 *   • observed cost lower than reserve ⇒ true-up reduces today's running total
 *   • generator returning cost_usd undefined defaults to 0
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  makeRealLlmDriver,
  LlmCostCapExceededError,
} from '../../crystallize/llm-draft.js';
import { tryReserve, readDailySpend } from '../../crystallize/cost-counter.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

function freshDb(): Database {
  return new Database(':memory:');
}

describe('crystallize/llm-draft (FX-21)', () => {
  test('happy path reserves + calls generator + records spend', async () => {
    const db = freshDb();
    let calls = 0;
    const gen = async (opts: { prompt: string; workload: string }) => {
      calls++;
      expect(opts.workload).toBe('summarization');
      return { content: 'hello\n', cost_usd: 0.07 };
    };
    const drv = makeRealLlmDriver({
      db,
      perRunReserveUsd: 0.1,
      generator: gen as any,
    });
    const r = await drv('p');
    expect(calls).toBe(1);
    expect(r.content).toBe('hello\n');
    expect(r.cost_usd).toBe(0.07);
    // Reserved 0.10 then trued-up by (0.07 - 0.10) = -0.03 ⇒ net 0.07.
    expect(readDailySpend(db)).toBeCloseTo(0.07, 5);
  });

  test('FX-21: cap exceeded ⇒ LlmCostCapExceededError BEFORE generator runs', async () => {
    const fx = FX('FX-21-cost-cap-per-run');
    const db = freshDb();
    // Pre-spend $0.95 of $1.00 ⇒ a $0.10 reserve must be rejected.
    tryReserve(db, fx.input.preexisting_spend_usd, fx.input.cap_usd);

    let called = 0;
    const gen = async () => {
      called++;
      return { content: 'x', cost_usd: 0.1 };
    };
    const drv = makeRealLlmDriver({
      db,
      perRunReserveUsd: fx.input.per_run_reserve_usd,
      generator: gen as any,
    });

    let err: unknown;
    try {
      await drv('p');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LlmCostCapExceededError);
    expect((err as LlmCostCapExceededError).spent_today_before).toBeCloseTo(
      fx.expected.spent_today_before,
      5,
    );
    expect((err as LlmCostCapExceededError).cap_usd).toBeCloseTo(
      fx.expected.cap_usd,
      5,
    );
    expect(called).toBe(0);
  });

  test('generator returning undefined cost_usd defaults to 0', async () => {
    const db = freshDb();
    const gen = async () => ({ content: 'x' });
    const drv = makeRealLlmDriver({
      db,
      perRunReserveUsd: 0.1,
      generator: gen as any,
    });
    const r = await drv('p');
    expect(r.cost_usd).toBe(0);
    expect(readDailySpend(db)).toBe(0);
  });
});
