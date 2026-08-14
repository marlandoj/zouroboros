import { describe, expect, test } from 'bun:test';
import { createCommandHub } from './commands.js';
import {
  executeOperatorShortcut,
  OPERATOR_SHORTCUTS,
  registerOperatorShortcuts,
  resolveOperatorShortcut,
  type ShortcutDefinition,
} from './shortcuts.js';

describe('operator shortcuts', () => {
  test('resolves canonical phrases and held-out paraphrases to typed read-only workflows', () => {
    const cases = [
      ['/status', 'status'],
      ['show zouroboros status', 'status'],
      ['run zouroboros doctor', 'doctor'],
      ['verify zouroboros governance', 'governance-verify'],
      ['search my memory for "authorization envelope"', 'memory-search'],
      ['check swarm status', 'swarm-status'],
    ] as const;
    for (const [input, id] of cases) {
      const result = resolveOperatorShortcut(input);
      expect(result.kind).toBe('match');
      if (result.kind !== 'match') throw new Error('expected match');
      expect(result.envelope.id).toBe(id);
      expect(result.envelope.version).toBe(1);
      expect(result.envelope.readOnly).toBe(true);
      expect(result.envelope.workflow.readOnly).toBe(true);
    }
  });

  test('passes memory arguments without introducing a shell string', () => {
    const result = resolveOperatorShortcut('/memory search "single-use authorization"');
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') throw new Error('expected match');
    expect(result.envelope.arguments.query).toBe('single-use authorization');
    expect(result.envelope.workflow.args.slice(-2)).toEqual(['single-use authorization', '--no-hyde']);
  });

  test('routes global swarm status to the existing no-argument read-only workflow', () => {
    const result = resolveOperatorShortcut('/swarm status');
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') throw new Error('expected match');
    expect(result.envelope.workflow.args).toEqual(['packages/swarm/scripts/orchestrate-v5.ts', 'doctor']);
  });

  test('fails closed for unsupported, privilege-expanding, missing, and ambiguous inputs', async () => {
    let executions = 0;
    const executor = () => {
      executions++;
      return { status: 'ok' as const, output: 'ran' };
    };
    for (const input of ['/doctor --fix', '/deploy', '/merge', '/memory search']) {
      expect((await executeOperatorShortcut(input, executor)).status).toBe('no-op');
    }
    const duplicate: ShortcutDefinition = { ...OPERATOR_SHORTCUTS[0], id: 'doctor' };
    const ambiguous = await executeOperatorShortcut('/status', executor, [OPERATOR_SHORTCUTS[0], duplicate]);
    expect(ambiguous.status).toBe('no-op');
    expect(ambiguous.error).toBe('ambiguous');
    expect(executions).toBe(0);
  });

  test('extends CommandHub with the five versioned workflows', async () => {
    const hub = createCommandHub();
    registerOperatorShortcuts(hub, (envelope) => ({ status: 'ok', output: envelope.id, data: envelope }));
    expect((await hub.execute('/status')).output).toBe('status');
    expect((await hub.execute('/doctor')).output).toBe('doctor');
    expect((await hub.execute('/governance verify')).output).toBe('governance-verify');
    expect((await hub.execute('/memory search "governed routing"')).output).toBe('memory-search');
    expect((await hub.execute('/swarm status')).output).toBe('swarm-status');
  });
});
