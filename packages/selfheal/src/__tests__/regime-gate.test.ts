import { describe, test, expect } from 'bun:test';
import {
  classifyRegime,
  formatRegimeAdvisory,
  type ProbeResult,
  type ProbeRunner,
  type RegimeInput,
  type MetricDirection,
} from '../evolve/regime-gate.js';

/** Build a stub probe runner that returns a fixed result and records the command it saw. */
function stubRunner(result: ProbeResult): { runner: ProbeRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: ProbeRunner = (cmd: string) => {
    calls.push(cmd);
    return result;
  };
  return { runner, calls };
}

const ok = (value: number | null, detail?: string): ProbeResult => ({ value, ok: true, detail });
const fail = (detail?: string): ProbeResult => ({ value: null, ok: false, detail });

describe('classifyRegime — no-op when no cheap probe declared', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
  ] as const)('%s cheapProbeCommand → unknown no-op, runner never called', (_label, cmd) => {
    const { runner, calls } = stubRunner(ok(1));
    const input: RegimeInput = {
      cheapProbeCommand: cmd,
      metricDirection: 'higher_is_better',
      baseline: 0.5,
      target: 0.9,
    };
    const c = classifyRegime(input, runner);
    expect(c.regime).toBe('unknown');
    expect(c.cheapValue).toBeNull();
    expect(calls.length).toBe(0);
    expect(c.rationale).toContain('no-op');
  });
});

describe('classifyRegime — deterministic (cheap path suffices)', () => {
  test('higher_is_better: cheap value meets target → deterministic', () => {
    const { runner } = stubRunner(ok(0.95));
    const c = classifyRegime(
      { cheapProbeCommand: 'grep -c foo', metricDirection: 'higher_is_better', baseline: 0.5, target: 0.9 },
      runner,
    );
    expect(c.regime).toBe('deterministic');
    expect(c.cheapValue).toBe(0.95);
    expect(c.meetsTarget).toBe(true);
    expect(c.improved).toBe(true);
    expect(c.rationale).toContain('gold-plating');
  });

  test('lower_is_better: cheap value meets (lower) target → deterministic', () => {
    const { runner } = stubRunner(ok(0.1));
    const c = classifyRegime(
      { cheapProbeCommand: 'wc -l', metricDirection: 'lower_is_better', baseline: 0.8, target: 0.2 },
      runner,
    );
    expect(c.regime).toBe('deterministic');
    expect(c.meetsTarget).toBe(true);
  });

  test('no target: cheap value improves baseline → deterministic', () => {
    const { runner } = stubRunner(ok(0.7));
    const c = classifyRegime(
      { cheapProbeCommand: 'jq .x', metricDirection: 'higher_is_better', baseline: 0.5 },
      runner,
    );
    expect(c.regime).toBe('deterministic');
    expect(c.improved).toBe(true);
    expect(c.meetsTarget).toBe(false);
    expect(c.rationale).toContain('improves baseline');
  });
});

describe('classifyRegime — agentic (cheap path insufficient)', () => {
  test('higher_is_better: cheap value misses target → agentic', () => {
    const { runner } = stubRunner(ok(0.6));
    const c = classifyRegime(
      { cheapProbeCommand: 'grep -c foo', metricDirection: 'higher_is_better', baseline: 0.5, target: 0.9 },
      runner,
    );
    expect(c.regime).toBe('agentic');
    expect(c.meetsTarget).toBe(false);
    expect(c.rationale).toContain('escalation justified');
  });

  test('no target: cheap value does not improve baseline → agentic', () => {
    const { runner } = stubRunner(ok(0.5));
    const c = classifyRegime(
      { cheapProbeCommand: 'jq .x', metricDirection: 'higher_is_better', baseline: 0.5 },
      runner,
    );
    expect(c.regime).toBe('agentic');
    expect(c.improved).toBe(false);
  });
});

describe('classifyRegime — direction flips classification', () => {
  test.each([
    ['higher_is_better', 0.3, 0.5, 'agentic'],
    ['lower_is_better', 0.3, 0.5, 'deterministic'],
  ] as const)(
    '%s with cheapValue=%d baseline=%d → %s',
    (direction, cheapValue, baseline, expected) => {
      const { runner } = stubRunner(ok(cheapValue));
      const c = classifyRegime(
        { cheapProbeCommand: 'probe', metricDirection: direction as MetricDirection, baseline },
        runner,
      );
      expect(c.regime).toBe(expected);
    },
  );
});

describe('classifyRegime — fail-safe to unknown, never blocks', () => {
  test('probe runner throws → unknown', () => {
    const runner: ProbeRunner = () => {
      throw new Error('spawn ENOENT');
    };
    const c = classifyRegime(
      { cheapProbeCommand: 'boom', metricDirection: 'higher_is_better', baseline: 0.5, target: 0.9 },
      runner,
    );
    expect(c.regime).toBe('unknown');
    expect(c.cheapValue).toBeNull();
    expect(c.rationale).toContain('fail-safe');
  });

  test('command failed (ok=false) → unknown', () => {
    const { runner } = stubRunner(fail('exit 1'));
    const c = classifyRegime(
      { cheapProbeCommand: 'false', metricDirection: 'higher_is_better', baseline: 0.5 },
      runner,
    );
    expect(c.regime).toBe('unknown');
    expect(c.rationale).toContain('failed');
  });

  test('unparseable metric (value=null, ok=true) → unknown', () => {
    const { runner } = stubRunner(ok(null, 'not a number'));
    const c = classifyRegime(
      { cheapProbeCommand: 'echo hi', metricDirection: 'higher_is_better', baseline: 0.5 },
      runner,
    );
    expect(c.regime).toBe('unknown');
    expect(c.rationale).toContain('unparseable');
  });

  test('NaN metric → unknown', () => {
    const { runner } = stubRunner(ok(NaN));
    const c = classifyRegime(
      { cheapProbeCommand: 'echo NaN', metricDirection: 'higher_is_better', baseline: 0.5 },
      runner,
    );
    expect(c.regime).toBe('unknown');
  });
});

describe('classifyRegime — rationale + carried fields always populated', () => {
  test.each([
    ['deterministic', ok(0.95)],
    ['agentic', ok(0.6)],
    ['unknown', fail()],
  ] as const)('%s classification has a non-empty rationale', (_label, probe) => {
    const { runner } = stubRunner(probe);
    const c = classifyRegime(
      { cheapProbeCommand: 'probe', metricDirection: 'higher_is_better', baseline: 0.5, target: 0.9 },
      runner,
    );
    expect(typeof c.rationale).toBe('string');
    expect(c.rationale.length).toBeGreaterThan(0);
    expect(c.baseline).toBe(0.5);
  });

  test('target carried through as null when absent', () => {
    const { runner } = stubRunner(ok(0.7));
    const c = classifyRegime(
      { cheapProbeCommand: 'probe', metricDirection: 'higher_is_better', baseline: 0.5 },
      runner,
    );
    expect(c.target).toBeNull();
  });
});

describe('formatRegimeAdvisory', () => {
  test('renders a single [REGIME] marker line', () => {
    const { runner } = stubRunner(ok(0.95));
    const c = classifyRegime(
      { cheapProbeCommand: 'probe', metricDirection: 'higher_is_better', baseline: 0.5, target: 0.9 },
      runner,
    );
    const line = formatRegimeAdvisory(c);
    expect(line.startsWith('[REGIME] deterministic:')).toBe(true);
    expect(line).toContain(c.rationale);
  });
});
