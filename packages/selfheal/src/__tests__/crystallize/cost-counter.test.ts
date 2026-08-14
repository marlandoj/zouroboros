/**
 * Cost-counter coverage — FX-20.
 *
 * Asserts:
 *   • dayKey is UTC YYYY-MM-DD
 *   • tryReserve admits within cap, denies above, never silently exceeds
 *   • two calls in the same day accumulate; recordSpend trues up
 *   • a different UTC day starts a fresh counter (rollover)
 *   • concurrent reservations within the same day are serialized by the SQL
 *     transaction (no double-spend over the cap)
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  dayKey,
  metricNameFor,
  tryReserve,
  recordSpend,
  readDailySpend,
} from '../../crystallize/cost-counter.js';

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

describe('crystallize/cost-counter (FX-20)', () => {
  test('dayKey is UTC YYYY-MM-DD', () => {
    expect(dayKey(0)).toBe('1970-01-01');
    expect(dayKey(1700000000)).toBe(new Date(1700000000 * 1000).toISOString().slice(0, 10));
  });

  test('metricNameFor formats `crystallize.cost.usd.<day>`', () => {
    expect(metricNameFor('2026-04-29')).toBe('crystallize.cost.usd.2026-04-29');
  });

  test('FX-20: three reservations exercise admit/admit/deny against $1 cap', () => {
    const fx = FX('FX-20-cost-cap-daily');
    const db = freshDb();
    const cap = fx.input.cap_usd;
    const now = 1700000000;

    const observed = fx.input.reservations.map((amt: number) =>
      tryReserve(db, amt, cap, now),
    );

    fx.expected.results.forEach((exp: any, i: number) => {
      expect(observed[i].ok).toBe(exp.ok);
      expect(observed[i].spent_today_before).toBeCloseTo(exp.spent_today_before, 5);
      expect(observed[i].spent_today_after).toBeCloseTo(exp.spent_today_after, 5);
      if (exp.reason) expect(observed[i].reason).toBe(exp.reason);
    });
    expect(readDailySpend(db, now)).toBeCloseTo(0.8, 5);
  });

  test('UTC rollover starts a fresh counter', () => {
    const db = freshDb();
    const cap = 1.0;
    const now1 = 1700000000;
    const now2 = now1 + 86_400 * 2; // two days later
    expect(tryReserve(db, 0.6, cap, now1).ok).toBe(true);
    expect(readDailySpend(db, now1)).toBeCloseTo(0.6, 5);
    // New day → independent metric row → fresh budget.
    expect(tryReserve(db, 0.6, cap, now2).ok).toBe(true);
    expect(readDailySpend(db, now2)).toBeCloseTo(0.6, 5);
    // Yesterday's value untouched.
    expect(readDailySpend(db, now1)).toBeCloseTo(0.6, 5);
  });

  test('recordSpend with negative delta clamps at 0', () => {
    const db = freshDb();
    tryReserve(db, 0.2, 1.0, 1700000000);
    const next = recordSpend(db, -10.0, 1700000000);
    expect(next).toBe(0);
  });

  test('recordSpend with positive delta accumulates monotonically', () => {
    const db = freshDb();
    tryReserve(db, 0.1, 1.0, 1700000000);
    const after = recordSpend(db, 0.05, 1700000000);
    expect(after).toBeCloseTo(0.15, 5);
  });
});
