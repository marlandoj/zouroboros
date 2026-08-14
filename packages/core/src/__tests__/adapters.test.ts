import { describe, test, expect } from 'bun:test';
import {
  createAdapters,
  resolveAdapterMode,
  createZoAdapters,
  createNoopAdapters,
  parseAgentList,
  type NotifyMessage,
} from '../adapters/index.js';

// ── mode resolution ──────────────────────────────────────────────────

describe('resolveAdapterMode', () => {
  test('bare box (no token) → noop', () => {
    expect(resolveAdapterMode({})).toBe('noop');
  });

  test('ZO_CLIENT_IDENTITY_TOKEN present → zo', () => {
    expect(resolveAdapterMode({ ZO_CLIENT_IDENTITY_TOKEN: 'tok' })).toBe('zo');
  });

  test('ZO_TOKEN present → zo', () => {
    expect(resolveAdapterMode({ ZO_TOKEN: 'tok' })).toBe('zo');
  });

  test('ZOUROBOROS_ADAPTER=noop forces noop even with a token', () => {
    expect(resolveAdapterMode({ ZO_TOKEN: 'tok', ZOUROBOROS_ADAPTER: 'noop' })).toBe('noop');
  });

  test('ZOUROBOROS_ADAPTER=zo without a token still falls back to noop', () => {
    expect(resolveAdapterMode({ ZOUROBOROS_ADAPTER: 'zo' })).toBe('noop');
  });
});

// ── factory ──────────────────────────────────────────────────────────

describe('createAdapters', () => {
  test('bare box yields noop adapters and never throws', () => {
    const a = createAdapters({ env: {}, logger: () => {} });
    expect(a.mode).toBe('noop');
    expect(a.notifier.kind).toBe('noop');
    expect(a.scheduler.kind).toBe('noop');
    expect(a.agents.kind).toBe('noop');
  });

  test('token yields zo adapters', () => {
    const a = createAdapters({ env: { ZO_CLIENT_IDENTITY_TOKEN: 'tok' }, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    expect(a.mode).toBe('zo');
    expect(a.notifier.kind).toBe('zo');
    expect(a.agents.kind).toBe('zo');
  });
});

// ── noop behavior ────────────────────────────────────────────────────

describe('noop adapters', () => {
  test('notifier logs instead of sending', async () => {
    const lines: string[] = [];
    const { notifier } = createNoopAdapters({ logger: (l) => lines.push(l) });
    await notifier.notify({ subject: 'hi', body: 'there' });
    expect(lines.join('\n')).toContain('[notify]');
    expect(lines.join('\n')).toContain('hi');
  });

  test('scheduler returns crontab instructions without registering', async () => {
    const { scheduler } = createNoopAdapters({ logger: () => {} });
    const r = await scheduler.schedule({ name: 'healer', command: 'bun healer.ts auto', intervalMinutes: 30 });
    expect(r.scheduled).toBe(false);
    expect(r.instructions).toContain('crontab');
    expect(r.instructions).toContain('*/30');
  });

  test('agent registry is unavailable and degrades to empty', async () => {
    const { agents } = createNoopAdapters({ logger: () => {} });
    expect(agents.available()).toBe(false);
    expect(await agents.list()).toEqual([]);
    expect(await agents.setModel('a', 'm')).toBe(false);
  });

  test('probe reports no transport so callers can fall back', async () => {
    const { agents } = createNoopAdapters({ logger: () => {} });
    const r = await agents.probe({ model: 'gpt-x', prompt: 'ping' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no transport');
  });
});

// ── zo behavior (injected fetch, no network) ─────────────────────────

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('zo adapters', () => {
  test('notifier calls send_email_to_user via MCP', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return jsonResponse({ result: { content: [{ text: 'ok' }] } });
    }) as unknown as typeof fetch;
    const { notifier } = createZoAdapters({ token: 'tok', fetchImpl });
    await notifier.notify({ subject: 'Alert', body: 'body' });
    expect(calls[0].body.params.name).toBe('send_email_to_user');
    expect(calls[0].body.params.arguments.subject).toBe('Alert');
  });

  test('notifier routes sms channel to send_sms_to_user', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return jsonResponse({ result: { content: [{ text: 'ok' }] } });
    }) as unknown as typeof fetch;
    const { notifier } = createZoAdapters({ token: 'tok', fetchImpl });
    const msg: NotifyMessage = { subject: 'S', body: 'B', channel: 'sms' };
    await notifier.notify(msg);
    expect(calls[0].params.name).toBe('send_sms_to_user');
  });

  test('agent registry parses list_agents and edits models', async () => {
    const listRaw = "id='a1' title='Coder' model='claude' active=True id='a2' title='Judge' model='gpt' active=False";
    let editArgs: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.params.name === 'list_agents') return jsonResponse({ result: { content: [{ text: listRaw }] } });
      if (body.params.name === 'edit_agent') { editArgs = body.params.arguments; return jsonResponse({ result: { content: [{ text: 'ok' }] } }); }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const { agents } = createZoAdapters({ token: 'tok', fetchImpl });
    const list = await agents.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'a1', model: 'claude', active: true });
    expect(list[1].active).toBe(false);
    expect(await agents.setModel('a1', 'opus')).toBe(true);
    expect(editArgs).toEqual({ agent_id: 'a1', model: 'opus' });
  });

  test('probe returns output on 200', async () => {
    const fetchImpl = (async () => jsonResponse({ output: 'pong' })) as unknown as typeof fetch;
    const { agents } = createZoAdapters({ token: 'tok', fetchImpl });
    const r = await agents.probe({ model: 'm', prompt: 'ping' });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('pong');
  });

  test('probe reports failure on non-2xx', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, false, 503)) as unknown as typeof fetch;
    const { agents } = createZoAdapters({ token: 'tok', fetchImpl });
    const r = await agents.probe({ model: 'm', prompt: 'ping' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  test('notifier swallows MCP errors (never throws at call site)', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const { notifier } = createZoAdapters({ token: 'tok', fetchImpl, logger: () => {} });
    await expect(notifier.notify({ subject: 's', body: 'b' })).resolves.toBeUndefined();
  });
});

// ── parser unit ──────────────────────────────────────────────────────

describe('parseAgentList', () => {
  test('ignores entries without id or model', () => {
    expect(parseAgentList("title='orphan'")).toEqual([]);
  });

  test('defaults title and active', () => {
    const [a] = parseAgentList("id='x' model='m'");
    expect(a.title).toBe('Untitled');
    expect(a.active).toBe(true);
  });
});
