import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  renderStrategyEntry,
  parseStrategyMarkdown,
  formatStrategyContext,
  appendStrategyNote,
  loadStrategy,
  strategyPath,
  nextIteration,
  STRATEGY_FILE_PREFIX,
  type StrategyEntry,
} from '../evolve/strategy-md.js';

const entry = (over: Partial<StrategyEntry> = {}): StrategyEntry => ({
  timestamp: '2026-07-01T00:00:00.000Z',
  prescriptionId: 'pres-abc',
  iteration: 0,
  regime: 'deterministic',
  action: 'cheap-probe short-circuit',
  outcome: 'met target 0.9',
  ...over,
});

describe('renderStrategyEntry ↔ parseStrategyMarkdown (pure, round-trip)', () => {
  test('render produces a header + bullet block ending in newline', () => {
    const md = renderStrategyEntry(entry());
    expect(md.startsWith('## 2026-07-01T00:00:00.000Z · iter 0 · deterministic')).toBe(true);
    expect(md).toContain('- prescription: pres-abc');
    expect(md).toContain('- action: cheap-probe short-circuit');
    expect(md).toContain('- outcome: met target 0.9');
    expect(md.endsWith('\n')).toBe(true);
  });

  test('note omitted when absent, present when set', () => {
    expect(renderStrategyEntry(entry())).not.toContain('- note:');
    expect(renderStrategyEntry(entry({ note: 'skipped 8h autoloop' }))).toContain('- note: skipped 8h autoloop');
  });

  test('round-trips a single entry', () => {
    const e = entry({ iteration: 3, note: 'BeautifulSoup solved it sub-second' });
    const [parsed] = parseStrategyMarkdown(renderStrategyEntry(e));
    expect(parsed).toEqual(e);
  });

  test('round-trips multiple entries in order', () => {
    const a = entry({ iteration: 0, regime: 'agentic', outcome: 'fell 0.04 short' });
    const b = entry({ iteration: 1, regime: 'deterministic', outcome: 'met target' });
    const content = renderStrategyEntry(a) + '\n' + renderStrategyEntry(b);
    const parsed = parseStrategyMarkdown(content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].iteration).toBe(0);
    expect(parsed[1].iteration).toBe(1);
  });

  test('collapses newlines in free-form fields so entries stay one block', () => {
    const e = entry({ note: 'line one\nline two', action: 'multi\nline' });
    const md = renderStrategyEntry(e);
    expect(md).toContain('- note: line one line two');
    expect(md).toContain('- action: multi line');
    const [parsed] = parseStrategyMarkdown(md);
    expect(parsed.note).toBe('line one line two');
  });

  test('parser ignores preamble / unknown lines', () => {
    const content = [
      '# Strategy scratchpad — playbook `x`',
      '',
      'some prose preamble',
      '',
      ...renderStrategyEntry(entry()).split('\n'),
    ].join('\n');
    const parsed = parseStrategyMarkdown(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].prescriptionId).toBe('pres-abc');
  });

  test('empty content ⇒ no entries', () => {
    expect(parseStrategyMarkdown('')).toEqual([]);
  });
});

describe('formatStrategyContext (pure)', () => {
  test('empty history ⇒ empty string (caller injects nothing)', () => {
    expect(formatStrategyContext([])).toBe('');
  });

  test('renders recent entries as a seed-ready block', () => {
    const ctx = formatStrategyContext([entry({ iteration: 0, note: 'n' })]);
    expect(ctx.startsWith('prior_strategy_notes:')).toBe(true);
    expect(ctx).toContain('iter 0 [deterministic] cheap-probe short-circuit → met target 0.9 (n)');
  });

  test('caps to the most recent N (default 5)', () => {
    const entries = Array.from({ length: 8 }, (_v, i) => entry({ iteration: i }));
    const ctx = formatStrategyContext(entries);
    const bullets = ctx.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(bullets).toHaveLength(5);
    // Most recent kept: iterations 3..7.
    expect(ctx).toContain('iter 7 ');
    expect(ctx).not.toContain('iter 2 ');
  });

  test('respects an explicit limit', () => {
    const entries = Array.from({ length: 4 }, (_v, i) => entry({ iteration: i }));
    const ctx = formatStrategyContext(entries, { limit: 2 });
    const bullets = ctx.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(bullets).toHaveLength(2);
  });
});

describe('appendStrategyNote / loadStrategy (append-only IO)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strategy-md-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('strategyPath keys by playbook id under the given dir', () => {
    const p = strategyPath('reduce-latency', dir);
    expect(p).toBe(join(dir, `${STRATEGY_FILE_PREFIX}reduce-latency.md`));
  });

  test('sanitizes unsafe playbook ids into the filename', () => {
    const p = strategyPath('weird/id with spaces', dir);
    expect(p).toBe(join(dir, `${STRATEGY_FILE_PREFIX}weird-id-with-spaces.md`));
  });

  test('first append creates file with preamble; loadStrategy reads it back', () => {
    appendStrategyNote(
      { playbookId: 'pb', prescriptionId: 'pres-1', iteration: 0, regime: 'agentic', action: 'autoloop', outcome: 'fell short' },
      { dir, now: Date.parse('2026-07-01T00:00:00.000Z') },
    );
    const path = strategyPath('pb', dir);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('# Strategy scratchpad');
    const loaded = loadStrategy('pb', dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ prescriptionId: 'pres-1', regime: 'agentic', action: 'autoloop' });
  });

  test('is append-only: prior entries survive later appends', () => {
    appendStrategyNote(
      { playbookId: 'pb', prescriptionId: 'p1', iteration: 0, regime: 'agentic', action: 'a1', outcome: 'o1' },
      { dir },
    );
    appendStrategyNote(
      { playbookId: 'pb', prescriptionId: 'p2', iteration: 1, regime: 'deterministic', action: 'a2', outcome: 'o2' },
      { dir },
    );
    const loaded = loadStrategy('pb', dir);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => e.prescriptionId)).toEqual(['p1', 'p2']);
    // Original entry's fields are untouched by the second append.
    expect(loaded[0].action).toBe('a1');
  });

  test('nextIteration = count of existing entries', () => {
    expect(nextIteration('pb', dir)).toBe(0);
    appendStrategyNote({ playbookId: 'pb', prescriptionId: 'p', iteration: 0, regime: 'unknown', action: 'a', outcome: 'o' }, { dir });
    expect(nextIteration('pb', dir)).toBe(1);
  });

  test('loadStrategy on absent file ⇒ [] (fail-safe)', () => {
    expect(loadStrategy('never-written', dir)).toEqual([]);
  });

  test('appendStrategyNote returns the stored entry with derived timestamp', () => {
    const stored = appendStrategyNote(
      { playbookId: 'pb', prescriptionId: 'p', iteration: 2, regime: 'deterministic', action: 'a', outcome: 'o', note: 'n' },
      { dir, now: Date.parse('2026-07-01T12:00:00.000Z') },
    );
    expect(stored.timestamp).toBe('2026-07-01T12:00:00.000Z');
    expect(stored.iteration).toBe(2);
    expect(stored.note).toBe('n');
  });
});
